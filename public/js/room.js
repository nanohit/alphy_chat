(function () {
  'use strict';

  // --- Quality tiers — start high, auto-adjust down if needed ---
  const QUALITY_TIERS = [
    { width: 1920, height: 1080, frameRate: 30, maxBitrate: 10000000, label: '1080p+' },
    { width: 1920, height: 1080, frameRate: 30, maxBitrate: 5000000,  label: '1080p' },
    { width: 1280, height: 720,  frameRate: 30, maxBitrate: 2500000,  label: '720p' },
    { width: 960,  height: 540,  frameRate: 24, maxBitrate: 1200000,  label: '540p' },
    { width: 640,  height: 360,  frameRate: 20, maxBitrate: 600000,   label: '360p' },
  ];

  // --- RoomManager ---
  class RoomManager {
    constructor() {
      const pathMatch = window.location.pathname.match(/\/(\d{4})\/?$/);
      this.roomId = pathMatch ? pathMatch[1] : null;
      if (!this.roomId) {
        window.location.href = '/';
        return;
      }

      this.socket = null;
      this.localStream = null;
      this.peers = new Map(); // socketId -> { pc, stream, videoEl, lastStatBytes, lastStatTime }
      this.iceServers = [];
      this.isMuted = false;
      this.isVideoOff = false;
      this.usingBackCamera = false;
      this.hasMultipleCameras = false;
      this.wakeLock = null;
      this.statsInterval = null;

      // Adaptive quality state
      this.currentTierIndex = 0; // Start at highest
      this.degradeCount = 0;
      this.improveCount = 0;

      // DOM refs
      this.videoGrid = document.getElementById('videoGrid');
      this.localVideo = document.getElementById('localVideo');
      this.pip = document.getElementById('pip');
      this.statusOverlay = document.getElementById('statusOverlay');
      this.statusText = document.getElementById('statusText');
      this.roomCode = document.getElementById('roomCode');
      this.participantCount = document.getElementById('participantCount');
      this.relayBadge = document.getElementById('relayBadge');
      this.statsDisplay = document.getElementById('statsDisplay');
      this.muteBtn = document.getElementById('muteBtn');
      this.videoBtn = document.getElementById('videoBtn');
      this.flipBtn = document.getElementById('flipBtn');
      this.leaveBtn = document.getElementById('leaveBtn');
      this.copyLinkBtn = document.getElementById('copyLinkBtn');
      this.copyToast = document.getElementById('copyToast');

      this.roomCode.textContent = this.roomId;
      this.init();
    }

    async init() {
      try {
        this.statusText.textContent = 'Requesting camera & microphone...';
        await this.acquireMedia();
        this.updateMirror();
        this.statusText.textContent = 'Fetching connection config...';
        await this.fetchIceServers();
        this.statusText.textContent = 'Connecting to server...';
        this.connectSocket();
        this.bindControls();
        this.setupPipDrag();
        this.requestWakeLock();
        await this.detectCameras();
        this.startStatsMonitoring();
      } catch (err) {
        this.handleMediaError(err);
      }
    }

    // --- Media ---

    async acquireMedia() {
      const tier = QUALITY_TIERS[this.currentTierIndex];

      const constraints = {
        video: {
          width: { ideal: tier.width },
          height: { ideal: tier.height },
          frameRate: { ideal: tier.frameRate },
          facingMode: 'user',
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (err.name === 'OverconstrainedError') {
          this.localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });
        } else {
          throw err;
        }
      }

      this.localVideo.srcObject = this.localStream;
    }

    handleMediaError(err) {
      let msg;
      switch (err.name) {
        case 'NotAllowedError':
          msg = 'Camera/microphone permission denied. Please allow access and reload.';
          break;
        case 'NotFoundError':
          msg = 'No camera or microphone found on this device.';
          break;
        case 'NotReadableError':
          msg = 'Camera or microphone is already in use by another app.';
          break;
        default:
          msg = `Could not access media: ${err.message}`;
      }
      this.statusText.textContent = msg;
      this.statusOverlay.classList.add('error');
    }

    async detectCameras() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((d) => d.kind === 'videoinput');
        this.hasMultipleCameras = cameras.length > 1;
        this.flipBtn.hidden = !this.hasMultipleCameras;
      } catch {
        // Flip button stays hidden
      }
    }

    async flipCamera() {
      if (!this.hasMultipleCameras) return;

      this.usingBackCamera = !this.usingBackCamera;

      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { exact: this.usingBackCamera ? 'environment' : 'user' },
          },
          audio: false,
        });

        const newTrack = newStream.getVideoTracks()[0];
        const oldTrack = this.localStream.getVideoTracks()[0];

        // Replace track on all peer connections (no renegotiation)
        for (const [, peer] of this.peers) {
          const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) {
            await sender.replaceTrack(newTrack);
          }
        }

        // Replace in local stream
        this.localStream.removeTrack(oldTrack);
        oldTrack.stop();
        this.localStream.addTrack(newTrack);
        this.localVideo.srcObject = this.localStream;
        this.updateMirror();
      } catch (err) {
        // Revert on failure
        this.usingBackCamera = !this.usingBackCamera;
        console.error('Camera flip failed:', err);
      }
    }

    updateMirror() {
      // Only mirror front camera — back camera should show natural orientation
      this.localVideo.style.transform = this.usingBackCamera ? 'none' : 'scaleX(-1)';
    }

    // --- ICE Servers ---

    async fetchIceServers() {
      try {
        const res = await fetch('/api/turn-credentials');
        const servers = await res.json();
        this.iceServers = servers;
      } catch {
        this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      }
    }

    // --- Socket.io ---

    connectSocket() {
      this.socket = io({
        transports: ['websocket', 'polling'],
      });

      this.socket.on('connect', () => {
        this.socket.emit('join-room', { roomId: this.roomId });
      });

      this.socket.on('room-joined', ({ participants }) => {
        this.hideStatus();
        this.updateParticipantCount();

        // New joiner creates offers to all existing peers
        for (const peerId of participants) {
          this.createPeerConnection(peerId, true);
        }
      });

      this.socket.on('participant-joined', ({ socketId }) => {
        this.createPeerConnection(socketId, false);
        this.updateParticipantCount();
        this.adjustQuality();
      });

      this.socket.on('offer', async ({ sender, sdp }) => {
        const peer = this.peers.get(sender);
        if (!peer) return;
        try {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          this.socket.emit('answer', {
            target: sender,
            sdp: peer.pc.localDescription,
          });
        } catch (err) {
          console.error('Error handling offer from', sender, err);
        }
      });

      this.socket.on('answer', async ({ sender, sdp }) => {
        const peer = this.peers.get(sender);
        if (!peer) return;
        try {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (err) {
          console.error('Error handling answer from', sender, err);
        }
      });

      this.socket.on('ice-candidate', async ({ sender, candidate }) => {
        const peer = this.peers.get(sender);
        if (!peer) return;
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Error adding ICE candidate from', sender, err);
        }
      });

      this.socket.on('participant-left', ({ socketId }) => {
        this.removePeer(socketId);
        this.updateParticipantCount();
        this.adjustQuality();
      });

      this.socket.on('room-full', () => {
        this.statusText.textContent = 'Room is full (max 4 people).';
        this.statusOverlay.classList.add('error');
        setTimeout(() => {
          window.location.href = '/';
        }, 3000);
      });

      this.socket.on('reconnect', () => {
        this.socket.emit('join-room', { roomId: this.roomId });
      });

      this.socket.on('disconnect', () => {
        this.showStatus('Connection lost. Reconnecting...');
      });
    }

    // --- WebRTC ---

    createPeerConnection(peerId, isInitiator) {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });

      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }

      const remoteStream = new MediaStream();
      pc.ontrack = (event) => {
        remoteStream.addTrack(event.track);
        const peer = this.peers.get(peerId);
        if (peer && peer.videoEl) {
          peer.videoEl.srcObject = remoteStream;
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.socket.emit('ice-candidate', {
            target: peerId,
            candidate: event.candidate,
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
          this.restartIce(pc, peerId);
        }
        if (pc.iceConnectionState === 'disconnected') {
          setTimeout(() => {
            if (pc.iceConnectionState === 'disconnected') {
              this.restartIce(pc, peerId);
            }
          }, 3000);
        }
      };

      const videoEl = this.createRemoteVideo(peerId);

      this.peers.set(peerId, {
        pc,
        stream: remoteStream,
        videoEl,
        lastStatBytes: null,
        lastStatTime: null,
        isRelay: false,
        relayInterval: null,
      });

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          this.applyBitrateCap(pc);
          this.startRelayCheck(peerId);
        }
      };

      if (isInitiator) {
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            this.socket.emit('offer', {
              target: peerId,
              sdp: pc.localDescription,
            });
          })
          .catch((err) => console.error('Error creating offer:', err));
      }

      this.updateLayout();
      return pc;
    }

    restartIce(pc, peerId) {
      pc.createOffer({ iceRestart: true })
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          this.socket.emit('offer', {
            target: peerId,
            sdp: pc.localDescription,
          });
        })
        .catch((err) => console.error('ICE restart failed:', err));
    }

    removePeer(peerId) {
      const peer = this.peers.get(peerId);
      if (!peer) return;

      if (peer.relayInterval) clearInterval(peer.relayInterval);
      peer.pc.close();
      if (peer.videoEl && peer.videoEl.parentNode) {
        peer.videoEl.parentNode.remove();
      }
      this.peers.delete(peerId);
      this.updateLayout();
      this.updateRelayBadge();
    }

    async applyBitrateCap(pc) {
      const tier = QUALITY_TIERS[this.currentTierIndex];

      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = tier.maxBitrate;
        params.degradationPreference = 'maintain-resolution';
        try {
          await sender.setParameters(params);
        } catch (err) {
          console.warn('Could not set bitrate:', err);
        }
      }
    }

    // --- Adaptive Quality ---

    adjustQuality() {
      // Reset counters when participant count changes
      this.degradeCount = 0;
      this.improveCount = 0;
      // Apply current tier constraints
      this.applyCurrentTier();
    }

    async applyCurrentTier() {
      const tier = QUALITY_TIERS[this.currentTierIndex];

      // Adjust local video track constraints
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          await videoTrack.applyConstraints({
            width: { ideal: tier.width },
            height: { ideal: tier.height },
            frameRate: { ideal: tier.frameRate },
          });
        } catch {
          // Camera does its best
        }
      }

      // Apply bitrate cap on all peers
      for (const [, peer] of this.peers) {
        this.applyBitrateCap(peer.pc);
      }
    }

    adaptQuality(actualFps) {
      if (this.peers.size === 0) return;

      const tier = QUALITY_TIERS[this.currentTierIndex];
      const targetFps = tier.frameRate;

      // FPS significantly below target → degrade
      if (actualFps > 0 && actualFps < targetFps * 0.6) {
        this.degradeCount++;
        this.improveCount = 0;
      } else if (actualFps >= targetFps * 0.85) {
        this.improveCount++;
        this.degradeCount = 0;
      } else {
        // In between — reset both
        this.degradeCount = 0;
        this.improveCount = 0;
      }

      // Step down after 3 consecutive bad readings (~6 seconds)
      if (this.degradeCount >= 3 && this.currentTierIndex < QUALITY_TIERS.length - 1) {
        this.currentTierIndex++;
        this.applyCurrentTier();
        this.degradeCount = 0;
        this.improveCount = 0;
        console.log('Quality stepped DOWN to', QUALITY_TIERS[this.currentTierIndex].label);
      }

      // Step up after 8 consecutive good readings (~16 seconds of stable quality)
      if (this.improveCount >= 8 && this.currentTierIndex > 0) {
        this.currentTierIndex--;
        this.applyCurrentTier();
        this.degradeCount = 0;
        this.improveCount = 0;
        console.log('Quality stepped UP to', QUALITY_TIERS[this.currentTierIndex].label);
      }
    }

    // --- Stats Monitoring ---

    startStatsMonitoring() {
      this.statsInterval = setInterval(() => this.collectStats(), 2000);
    }

    async collectStats() {
      if (this.peers.size === 0) {
        this.statsDisplay.textContent = '';
        return;
      }

      let displayFps = 0;
      let displayRes = '';
      let displayBitrate = 0;
      let minFps = Infinity;

      for (const [, peer] of this.peers) {
        try {
          const stats = await peer.pc.getStats();
          for (const report of stats.values()) {
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              const fps = report.framesPerSecond || 0;

              if (report.frameWidth && report.frameHeight) {
                displayRes = `${report.frameHeight}p`;
              }
              displayFps = fps;
              if (fps > 0) minFps = Math.min(minFps, fps);

              // Calculate bitrate from bytes delta
              if (peer.lastStatBytes != null && peer.lastStatTime != null) {
                const dt = (report.timestamp - peer.lastStatTime) / 1000;
                if (dt > 0) {
                  const br = ((report.bytesSent - peer.lastStatBytes) * 8) / dt;
                  displayBitrate = Math.max(displayBitrate, br);
                }
              }
              peer.lastStatBytes = report.bytesSent;
              peer.lastStatTime = report.timestamp;
            }
          }
        } catch {
          // Stats not available yet
        }
      }

      const fps = Math.round(displayFps);
      if (fps > 0) {
        const bitrateStr =
          displayBitrate >= 1000000
            ? (displayBitrate / 1000000).toFixed(1) + 'Mbps'
            : Math.round(displayBitrate / 1000) + 'kbps';
        this.statsDisplay.textContent = `${displayRes} ${fps}fps ${bitrateStr}`;
      }

      // Feed into adaptive quality
      if (minFps < Infinity) {
        this.adaptQuality(minFps);
      }
    }

    // --- TURN Detection ---

    startRelayCheck(peerId) {
      const peer = this.peers.get(peerId);
      if (!peer) return;

      const check = async () => {
        try {
          const stats = await peer.pc.getStats();
          let isRelay = false;

          for (const [, report] of stats) {
            if (
              report.type === 'candidate-pair' &&
              report.state === 'succeeded' &&
              report.nominated
            ) {
              const localCandidate = stats.get(report.localCandidateId);
              const remoteCandidate = stats.get(report.remoteCandidateId);
              if (
                (localCandidate && localCandidate.candidateType === 'relay') ||
                (remoteCandidate && remoteCandidate.candidateType === 'relay')
              ) {
                isRelay = true;
              }
            }
          }

          peer.isRelay = isRelay;
          this.updateRelayBadge();
        } catch {
          // Stats not available yet
        }
      };

      check();
      peer.relayInterval = setInterval(check, 5000);
    }

    updateRelayBadge() {
      let anyRelay = false;
      for (const [, peer] of this.peers) {
        if (peer.isRelay) {
          anyRelay = true;
          break;
        }
      }
      this.relayBadge.hidden = !anyRelay;
    }

    // --- UI ---

    createRemoteVideo(peerId) {
      const wrapper = document.createElement('div');
      wrapper.className = 'video-wrapper';
      wrapper.dataset.peerId = peerId;

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.className = 'remote-video';

      wrapper.appendChild(video);
      this.videoGrid.appendChild(wrapper);

      return video;
    }

    updateLayout() {
      const total = this.peers.size + 1;
      this.videoGrid.className = `video-grid layout-${Math.min(total, 4)}`;
    }

    updateParticipantCount() {
      const count = this.peers.size + 1;
      this.participantCount.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
    }

    showStatus(msg) {
      this.statusText.textContent = msg;
      this.statusOverlay.hidden = false;
      this.statusOverlay.classList.remove('error');
    }

    hideStatus() {
      this.statusOverlay.hidden = true;
    }

    // --- Controls ---

    bindControls() {
      this.muteBtn.addEventListener('click', () => this.toggleMute());
      this.videoBtn.addEventListener('click', () => this.toggleVideo());
      this.flipBtn.addEventListener('click', () => this.flipCamera());
      this.leaveBtn.addEventListener('click', () => this.leave());
      this.copyLinkBtn.addEventListener('click', () => this.copyLink());

      document.addEventListener('keydown', (e) => {
        if (e.key === 'm' || e.key === 'M') this.toggleMute();
        if (e.key === 'v' || e.key === 'V') this.toggleVideo();
      });
    }

    toggleMute() {
      this.isMuted = !this.isMuted;
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = !this.isMuted;

      this.muteBtn.classList.toggle('active', this.isMuted);
      this.muteBtn.querySelector('.icon-mic-on').style.display = this.isMuted ? 'none' : '';
      this.muteBtn.querySelector('.icon-mic-off').style.display = this.isMuted ? '' : 'none';
    }

    toggleVideo() {
      this.isVideoOff = !this.isVideoOff;
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) videoTrack.enabled = !this.isVideoOff;

      this.videoBtn.classList.toggle('active', this.isVideoOff);
      this.videoBtn.querySelector('.icon-video-on').style.display = this.isVideoOff ? 'none' : '';
      this.videoBtn.querySelector('.icon-video-off').style.display = this.isVideoOff ? '' : 'none';
    }

    async copyLink() {
      const url = window.location.href;
      try {
        await navigator.clipboard.writeText(url);
        this.copyToast.hidden = false;
        setTimeout(() => {
          this.copyToast.hidden = true;
        }, 2000);
      } catch {
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        this.copyToast.hidden = false;
        setTimeout(() => {
          this.copyToast.hidden = true;
        }, 2000);
      }
    }

    leave() {
      if (this.statsInterval) clearInterval(this.statsInterval);

      for (const [, peer] of this.peers) {
        if (peer.relayInterval) clearInterval(peer.relayInterval);
        peer.pc.close();
      }
      this.peers.clear();

      if (this.localStream) {
        for (const track of this.localStream.getTracks()) {
          track.stop();
        }
      }

      if (this.wakeLock) {
        this.wakeLock.release().catch(() => {});
      }

      if (this.socket) {
        this.socket.emit('leave-room');
        this.socket.disconnect();
      }

      window.location.href = '/';
    }

    // --- PiP Drag ---

    setupPipDrag() {
      let isDragging = false;
      let startX, startY, startLeft, startTop;

      const pip = this.pip;

      pip.addEventListener('pointerdown', (e) => {
        isDragging = true;
        pip.setPointerCapture(e.pointerId);
        startX = e.clientX;
        startY = e.clientY;
        const rect = pip.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        pip.style.transition = 'none';
        // Immediately switch to top/left to prevent stretch on first move
        pip.style.left = `${rect.left}px`;
        pip.style.top = `${rect.top}px`;
        pip.style.right = 'auto';
        pip.style.bottom = 'auto';
      });

      pip.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        pip.style.left = `${startLeft + dx}px`;
        pip.style.top = `${startTop + dy}px`;
        pip.style.right = 'auto';
        pip.style.bottom = 'auto';
      });

      pip.addEventListener('pointerup', () => {
        isDragging = false;
        pip.style.transition = '';
        this.snapPipToCorner();
      });

      pip.addEventListener('pointercancel', () => {
        isDragging = false;
        pip.style.transition = '';
        this.snapPipToCorner();
      });
    }

    snapPipToCorner() {
      const pip = this.pip;
      const rect = pip.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const midX = window.innerWidth / 2;
      const midY = window.innerHeight / 2;

      const margin = 12;

      pip.style.left = 'auto';
      pip.style.top = 'auto';
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';

      if (centerX < midX) {
        pip.style.left = `${margin}px`;
      } else {
        pip.style.right = `${margin}px`;
      }

      if (centerY < midY) {
        pip.style.top = `${margin}px`;
      } else {
        pip.style.bottom = `${margin + 80}px`;
      }
    }

    // --- Wake Lock ---

    async requestWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          this.wakeLock = await navigator.wakeLock.request('screen');
          document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible' && !this.wakeLock) {
              try {
                this.wakeLock = await navigator.wakeLock.request('screen');
              } catch {
                /* ignore */
              }
            }
          });
        } catch {
          // Wake Lock not available or denied
        }
      }
    }
  }

  // --- Start ---
  new RoomManager();
})();
