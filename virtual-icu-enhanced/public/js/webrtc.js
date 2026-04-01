/* ============================================================
   virtual-icu / public / js / webrtc.js
   WebRTC for video calls (patient + family + nurse)
   ============================================================ */

class WebRTCManager {
  constructor(socket) {
    this.socket      = socket;
    this.localStream = null;
    this.peers       = {};
    this.onRemoteStream = null;
    this.onPeerLeft     = null;
    this.onConnected    = null;
    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
    this._bindSocketEvents();
  }

  async startLocalMedia(videoEl) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width:{ideal:1280}, height:{ideal:720} },
        audio: { echoCancellation:true, noiseSuppression:true }
      });
      if (videoEl) { videoEl.srcObject = this.localStream; videoEl.muted = true; }
      return { success: true };
    } catch(err) {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
        return { success:true, audioOnly:true };
      } catch(e) {
        return { success:false };
      }
    }
  }

  _makePeer(remoteId) {
    if (this.peers[remoteId]) { this.peers[remoteId].close(); }
    const pc = new RTCPeerConnection(this.iceConfig);
    this.peers[remoteId] = pc;
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    }
    pc.ontrack = (e) => {
      if (this.onRemoteStream) this.onRemoteStream(e.streams[0], remoteId);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('webrtc_ice_candidate', { to: remoteId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected' && this.onConnected) this.onConnected();
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    return pc;
  }

  async createOffer(toId) {
    const pc = this._makePeer(toId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.socket.emit('webrtc_offer', { to: toId, offer });
  }

  async handleOffer(offer, fromId) {
    const pc = this._makePeer(fromId);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.emit('webrtc_answer', { to: fromId, answer });
  }

  async handleAnswer(answer, fromId) {
    const pc = this.peers[fromId];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async handleIce(candidate, fromId) {
    const pc = this.peers[fromId];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    }
  }

  removePeer(id) {
    if (this.peers[id]) { this.peers[id].close(); delete this.peers[id]; if (this.onPeerLeft) this.onPeerLeft(id); }
  }

  toggleAudio() {
    if (!this.localStream) return false;
    const t = this.localStream.getAudioTracks();
    t.forEach(tr => tr.enabled = !tr.enabled);
    return !t[0]?.enabled;
  }

  toggleVideo() {
    if (!this.localStream) return false;
    const t = this.localStream.getVideoTracks();
    t.forEach(tr => tr.enabled = !tr.enabled);
    return !t[0]?.enabled;
  }

  async startScreenShare(el) {
    try {
      const ss = await navigator.mediaDevices.getDisplayMedia({ video:true });
      const t  = ss.getVideoTracks()[0];
      for (const pc of Object.values(this.peers)) {
        const s = pc.getSenders().find(s => s.track?.kind==='video');
        if (s) await s.replaceTrack(t);
      }
      if (el) el.srcObject = ss;
      t.onended = () => this.stopScreenShare(el);
      return true;
    } catch(e) { return false; }
  }

  async stopScreenShare(el) {
    const t = this.localStream?.getVideoTracks()[0];
    if (t) for (const pc of Object.values(this.peers)) {
      const s = pc.getSenders().find(s => s.track?.kind==='video');
      if (s) await s.replaceTrack(t);
    }
    if (el) el.srcObject = this.localStream;
  }

  hangup() {
    if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {};
  }

  _bindSocketEvents() {
    this.socket.on('webrtc_offer',         async ({ offer, from })     => await this.handleOffer(offer, from));
    this.socket.on('webrtc_answer',        async ({ answer, from })    => await this.handleAnswer(answer, from));
    this.socket.on('webrtc_ice_candidate', async ({ candidate, from }) => await this.handleIce(candidate, from));
  }
}

/* ============================================================
   WallRTC — completely separate WebRTC manager for video wall
   Uses wall_* events, never conflicts with regular calls
   ============================================================ */
class WallRTC {
  constructor(socket) {
    this.socket = socket;
    this.peers  = {};  // socketId → RTCPeerConnection
    this.iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    this._bind();
  }

  // Nurse calls this: create PC, send offer to patient
  async requestStream(patientSocketId, onStream) {
    if (this.peers[patientSocketId]) {
      this.peers[patientSocketId].close();
      delete this.peers[patientSocketId];
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peers[patientSocketId] = pc;

    pc.ontrack = (e) => {
      console.log('[WallRTC] Got stream from', patientSocketId);
      onStream(e.streams[0]);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('wall_ice', { to: patientSocketId, candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WallRTC] State:', patientSocketId, pc.connectionState);
    };

    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
    this.socket.emit('wall_offer_to_patient', { to: patientSocketId, offer });
    console.log('[WallRTC] Offer sent to patient', patientSocketId);
  }

  // Patient calls this: receive offer, send back camera
  async respondWithCamera(nurseSocketId, offer, stream) {
    if (this.peers[nurseSocketId]) {
      this.peers[nurseSocketId].close();
      delete this.peers[nurseSocketId];
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peers[nurseSocketId] = pc;

    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('wall_ice', { to: nurseSocketId, candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WallRTC] Patient state:', nurseSocketId, pc.connectionState);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.emit('wall_answer', { to: nurseSocketId, answer });
    console.log('[WallRTC] Answer sent to nurse', nurseSocketId);
  }

  closeAll() {
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {};
  }

  _bind() {
    // Nurse receives answer from patient
    this.socket.on('wall_answer', ({ answer, from }) => {
      const pc = this.peers[from];
      if (pc && pc.signalingState !== 'stable') {
        pc.setRemoteDescription(new RTCSessionDescription(answer))
          .then(() => console.log('[WallRTC] Answer applied from', from))
          .catch(e => console.warn('[WallRTC] Answer err:', e));
      }
    });

    // ICE candidates (both directions)
    this.socket.on('wall_ice', ({ candidate, from }) => {
      const pc = this.peers[from];
      if (pc && candidate) {
        pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
    });
  }
}
