/**
 * Generate a random, 32-digit, hecadeximal string
 *
 * @returns {string}
 */
function makeID() {
  const s = [];
  const hexDigits = '0123456789ABCDEF';
  for (let i = 0; i < 32; i += 1) {
    s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
  }

  return s.join('');
}


// ---------------------------------------------------------------
// -- ViewSharePeerSession
// ---------------------------------------------------------------

class ViewSharePeerSession {
  constructor(stopfunc) {
    this.id = makeID();
    this.stopfunc = stopfunc;

    this.RTCPC = new window.webkitRTCPeerConnection();

    this.RTCPC.onsignalingstatechange = (e) => {
      console.log('WEBRTC onsignalingstatechange', e);
    };

    this.RTCPC.oniceconnectionstatechange = () => {
      if (!this.RTCPC) return;

      console.log('WEBRTC: oniceconnectionstatechange', this.RTCPC.iceConnectionState);

      if (this.RTCPC.iceConnectionState === 'failed' &&
        typeof this.onclose === 'function') {
        this.onclose();
      }
    };
  }

  close() {
    if (!this.RTCPC || this.RTCPC.signalingState === 'closed') {
      return;
    }

    this.RTCPC.close();

    if (typeof this.stopfunc === 'function') {
      this.stopfunc();
    }

    delete this.RTCPC;
  }

  sendOffer(method) {
    const ps = this;
    return new Promise((resolve, reject) => {
      ps.webrtc.createOffer(resolve, reject);
    })
      .then((offer) => {
        ps.webrtc.setLocalDescription(offer);
        return vs.rpc(method, {
          id: ps.id,
          offer,
        });
      })
      .then(reply => (
        new Promise((resolve, reject) => {
          ps.webrtc.setRemoteDescription(
            new vs.SessionDescription(reply),
            resolve,
            reject,
          );
        })
      ));
  }
}

// ---------------------------------------------------------------
// -- Base class for DeviceConnection
// ---------------------------------------------------------------

class DeviceConnection {
  constructor(vs, type) {
    this.vs = vs;
    this.connectionType = type;
    this.loggedin = false;
    this.started = false;
    this.backoff = 1000;
    this.inflight = 0;
    this.reconnectCountdownTimer = null;
    this.reconnectTimer = null;
    this.subscriptions = {};
  }

  start() {
    if (this.active) return;
    this.suspended = false;
    this.active = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      clearInterval(this.reconnectCountdownTimer);
      this.vs.updateState('localstate', 'connecting', true);
      this.vs.updateState('localstate', 'reconnectCountdown', null);
      delete this.reconnectTimer;
    }
    this.connect();
  }

  login() {
    this.send({
      op: 'login',
      version: 1,
      username: this.vs.username,
      password: this.vs.password,
      token: this.vs.token,
      needInflight: this.needInflight,
    });
  }

  connected() {
    this.backoff = 1000;
    this.inflight = 0;
    if (!this.vs.username) {
      this.vs.updateState('localstate', 'authstatus', 'needlogin');
    } else {
      this.login();
    }
    this.vs.updateState('localstate', 'connecting', false);
    this.vs.updateState('localstate', 'errorcode', 0);
  }

  removeSubscriptions() {
    for (const k in this.subscriptions) {
      this.subscriptions[k].setConnection(null);
    }
  }

  connectionFailed(msg, code) {
    this.loggedin = false;
    this.vs.updateState('localstate', 'connecting', false);

    if (this.suspended) {
      console.warn(this.connectionType, ': Suspended');
      this.active = false;
      this.vs.selectPrimaryConnection();
      return;
    }

    console.warn(this.connectionType, ': Connection failed:', msg, code);
    this.vs.log(`${this.connectionType}: Connection failed: ${msg} ${code}`);
    const retry = this.disconnect();

    this.error = msg;
    this.errorcode = code;
    this.vs.updateState('localstate', 'errorcode', this.errorcode);
    this.vs.updateState('localstate', 'error', this.error);

    this.vs.selectPrimaryConnection();

    if (this.backoff > 10000) this.backoff = 10000;

    this.backoff *= 1.5 + Math.random() * 0.5;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      delete this.reconnectTimer;
    }

    if (this.reconnectCountdownTimer) {
      clearInterval(this.reconnectCountdownTimer);
    }

    this.removeSubscriptions();

    this.active = false;
    if (retry && !this.vs.pageHidden) {
      console.log('Trying to reconnect in', this.backoff);
      this.reconnectTimer = setTimeout(this.start.bind(this), this.backoff);
      this.countdown = this.backoff;
      this.reconnectCountdownTimer = setInterval(() => {
        this.countdown -= COUNTDOWN_INTERVAL;
        this.vs.updateState('localstate', 'reconnectCountdown', this.countdown);
      }, COUNTDOWN_INTERVAL);
    }
  }

  established() {
    const vs = this.vs;

    this.loggedin = true;
    vs.selectPrimaryConnection();

    if (vs.primaryConnection !== this) return;

    for (const k in this.vs.sendq) {
      this.send(this.vs.sendq[k]);
    }

    this.vs.sendq = [];
  }

  input(data) {
    if (data instanceof ArrayBuffer) {
      if (!this.loggedin) return;

      const u8 = new Uint8Array(data);
      const opcode = u8[0];
      switch (opcode) {
        case 3: {
          // In-flight data ack
          const bytes = u8[1] << 24 | u8[2] << 16 | u8[3] << 8 | u8[4];
          this.inflight -= bytes;
          console.log('inflight_sub', bytes, this.inflight);
          if(this.processSendq)
            this.processSendq();
          break;
        }
        case 1: // Last segment
        case 2: { // Not last segment
          const rpcid = u8[1] << 24 | u8[2] << 16 | u8[3] << 8 | u8[4];
          const rpc = this.vs.rpc_pending[rpcid];

          if (rpc) {
            const payload = new Uint8Array(data.slice(9));
            if (!rpc.accbuf) {
              const totallen = u8[5] << 24 | u8[6] << 16 | u8[7] << 8 | u8[8];
              rpc.accbuf = new Uint8Array(totallen);

              rpc.accbuf.set(payload);
              rpc.offset = payload.length;
            } else {
              rpc.accbuf.set(payload, rpc.offset);
              rpc.offset += payload.length;
            }
            if (opcode === 1) {
              clearTimeout(rpc.timer);
              rpc.resolve(rpc.accbuf);
              delete this.vs.rpc_pending[rpcid];
            }
          }
          break;
        }
      }
      return;
    }

    const msg = JSON.parse(data);

    if (!this.loggedin) {
      if (msg.op != 'loginresponse') {
        console.log('Expected loginreponse, got', msg);
        return;
      }

      if (msg.error) {
        this.vs.updateState('localstate', 'authstatus', 'badlogin');
        return;
      }

      if (msg.token) this.vs.token = msg.token;

      this.vs.myid = msg.id;
      this.vs.updateState('localstate', 'authstatus', 'loggedin');
      this.vs.updateState('localstate', 'myid', msg.id);
      if (msg.iceServers) this.vs.iceServers = msg.iceServers;
      this.established();
    } else {
      switch (msg.op) {
        case 'additem':
        case 'delitem':
        case 'moveitem':
        case 'updatefield':
        case 'subsync': {
          const sub = this.subscriptions[msg.subid];
          if (sub) sub.input(msg);
          break;
        }

        case 'rpc':
          this.rpc(msg);
          break;

        case 'rpcreply': {
          const rpc = this.vs.rpc_pending[msg.rpcid];
          if (rpc) {
            clearTimeout(rpc.timer);
            if (msg.error) {
              rpc.reject(new Error('Remote: ' + msg.error));
            } else {
              rpc.resolve(msg.result);
            }
            delete this.vs.rpc_pending[msg.rpcid];
          }
          break;
        }
        case 'rpcprogress': {
          const rpc = this.vs.rpc_pending[msg.rpcid];
          if (rpc) {
            clearTimeout(rpc.timer);
            const vs = this.vs;
            rpc.timer = setTimeout(function() {
              delete vs.rpc_pending[msg.rpcid];
              rpc.reject(new Error('Timeout'));
            }, rpc.timeout);
            if (rpc.ctrl && rpc.ctrl.progress) {
              rpc.ctrl.progress(msg.status, msg.value);
            }
          }
          break;
        }
        case 'setIceServers':
          this.vs.iceServers = msg.iceServers;
          break;
      }
    }
  }

  // Send a failing rpc response
  rpcError(rpcid, error) {
    this.send({
      op: 'rpcreply',
      rpcid,
      error,
    });
  }

  // Handle received RPC requests
  rpc(msg) {
    const rpcid = msg.rpcid;
    if (typeof this.vs.rpcmethods[msg.method] !== 'function') {
      console.error(`Got bad RPC call for unknown method: ${msg.method}`);
      if (rpcid === undefined) {
        this.rpcError(rpcid, `Not a valid RPC method: ${msg.method}`);
      }
      return;
    }

    // console.log('Got RPC ' + msg.method + ' id(' + rpcid + ')');

    const send = this.send.bind(this);

    this.vs.rpcmethods[msg.method](msg.args).then(function(reply) {
      if (rpcid === undefined) return;

      if (reply instanceof ArrayBuffer) {
        const length = reply.byteLength;
        // const MAX_CHUNK_SIZE = 16384;
        const MAX_CHUNK_SIZE = 16000;

        for (let offset = 0; offset < length; offset += MAX_CHUNK_SIZE) {
          let chunksize = length - offset;
          let opcode;
          if (chunksize > MAX_CHUNK_SIZE) {
            chunksize = MAX_CHUNK_SIZE;
            opcode = 2; // More to come
          } else {
            opcode = 1; // Last segment
          }

          const out = new Uint8Array(9 + chunksize);
          const pkt = new DataView(out.buffer);
          pkt.setUint8(0, opcode);
          pkt.setUint32(1, rpcid);
          pkt.setUint32(5, length);
          out.set(new Uint8Array(reply, offset, chunksize), 9);
          send(out);
        }
      } else {
        send({
          rpcid,
          op: 'rpcreply',
          result: reply,
        });
      }
    }).catch(function (err) {
      if (rpcid === undefined) return;

      send({
        rpcid,
        op: 'rpcreply',
        error: err.message,
      });
    });
  }
}

// ---------------------------------------------------------------
// -- Connection to device via WebRTC
// ---------------------------------------------------------------

class WebRTCDeviceConnection extends DeviceConnection {
  constructor(vs) {
    super(vs, 'WebRTC');
    this.prio = 100;
    this.statsTimer = -1;
    this.prevStats = null;
  }

  disconnect() {
    this.unsubscribeStats();
    const c = this.connection;
    if (c) {
      delete this.connection;
      c.close();
    }
    // Only retry if main connection is logged in
    return this.vs.connectionRV.loggedin;
  }

  connect() {
    const vs = this.vs;

    if (!vs.directEnable) {
      this.active = false;
      return;
    }

    if (!vs.token) {
      this.connectionFailed('No login token', 1001);
      return;
    }

    const ps = new ViewSharePeerSession(vs);
    this.subscribeStats(ps.webrtc);

    const vsc = ps.webrtc.createDataChannel('viewsharecontrol', {});

    vsc.onopen = () => {
      console.log('viewsharecontrol open');
      this.connected();
    };

    vsc.onmessage = (event) => {
      // console.log("WebRTC recv ctrl", event.data);
      this.input(event.data);
    };

    const vsb = ps.webrtc.createDataChannel('viewsharebulk', {});
    vsb.binaryType = 'arraybuffer';

    vsb.onopen = function() {
      console.log('viewsharebulk open');
    };

    vsb.onmessage = (event) => {
      // console.log("WebRTC recv bulk", event.data);
      this.input(event.data);
    };

    const metaconnection = {
      send(msg) {
        if (isAbv(msg)) {
          vsb.send(msg);
        } else {
          vsc.send(msg);
        }
      },
    };

    ps.sendOffer('webrtcControlStart')
      .then(() => {
        this.connection = metaconnection;
        console.log('WEBRTC: Datachannel connected');
      }).then(() => {
        ps.onclose = () => {
          delete this.connection;
          this.connectionFailed('ICE failed', 1000);
        };
      }).catch((e) => {
        console.log('WEBRTC: Datachannel failed', e);
        this.connectionFailed(e, 1002);
        ps.close();
      });
  }

  send(msg) {
    if (isAbv(msg)) {
      this.connection.send(msg);
    } else {
      // console.log("WebRTC send", msg);
      this.connection.send(JSON.stringify(msg));
    }
  }
}

// ---------------------------------------------------------------
// -- ViewShare Main Class
// ---------------------------------------------------------------

class ViewShare {
  constructor() {
    this.RTCPeerConnection = window.webkitRTCPeerConnection;
    this.IceCandidate = window.RTCIceCandidate;
    this.SessionDescription = window.RTCSessionDescription;

    this.subscriptions = [];
    this.sendq = [];
    this.rpc_pending = {};
    this.default_timeout = 60 * 1000;
    this.RTCPC_sessions = {};
    this.directEnable = true;
  }

  send(msg) {
    if (this.primaryConnection) {
      this.primaryConnection.send(msg);
      return;
    }

    this.sendq.push(msg);
    if (this.connectionRV.suspended) {
      this.connectionRV.start();
    }
  }
}

export default new ViewShare();
