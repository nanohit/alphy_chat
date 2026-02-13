(function () {
  'use strict';

  const createBtn = document.getElementById('createBtn');
  const codeInputs = Array.from(document.querySelectorAll('.code-digit'));
  const errorEl = document.getElementById('error');
  const loadingEl = document.getElementById('loading');
  const loadingText = document.getElementById('loadingText');

  let coldStartTimer = null;
  let isJoining = false;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    setTimeout(() => { errorEl.hidden = true; }, 5000);
  }

  function showLoading(msg) {
    loadingText.textContent = msg;
    loadingEl.hidden = false;
    createBtn.disabled = true;
    codeInputs.forEach((input) => { input.disabled = true; });

    // Show cold start hint after 3 seconds
    coldStartTimer = setTimeout(() => {
      loadingText.textContent = 'Server waking up... hang tight!';
    }, 3000);
  }

  function hideLoading() {
    loadingEl.hidden = true;
    createBtn.disabled = false;
    codeInputs.forEach((input) => { input.disabled = false; });
    if (coldStartTimer) {
      clearTimeout(coldStartTimer);
      coldStartTimer = null;
    }
  }

  function extractRoomId(input) {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const matches = trimmed.match(/(\d{4})(?!\d)/g);
    if (!matches) return null;
    return matches[matches.length - 1];
  }

  function readCode() {
    return codeInputs.map((input) => input.value).join('');
  }

  function fillCode(code) {
    const digits = code.split('');
    codeInputs.forEach((input, index) => {
      input.value = digits[index] || '';
    });
  }

  function focusInput(index) {
    const target = codeInputs[index];
    if (target) target.focus();
  }

  async function joinRoom(roomId) {
    if (isJoining) return;
    isJoining = true;
    showLoading('Joining room...');
    try {
      const res = await fetch(`/api/rooms/${roomId}`);
      if (res.status === 404) {
        hideLoading();
        showError('Room not found. Check the code and try again.');
        return;
      }
      const data = await res.json();
      if (data.isFull) {
        hideLoading();
        showError('Room is full (max 4 people).');
        return;
      }
      window.location.href = `/${roomId}`;
    } catch (err) {
      hideLoading();
      showError('Could not reach server. Please try again.');
    } finally {
      isJoining = false;
    }
  }

  function maybeJoin() {
    const code = readCode();
    const allFilled = codeInputs.every((input) => input.value !== '');
    if (allFilled && /^\d{4}$/.test(code)) {
      joinRoom(code);
    }
  }

  // Create room
  createBtn.addEventListener('click', async () => {
    showLoading('Creating room...');
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to create room');
      const { roomId } = await res.json();
      window.location.href = `/${roomId}`;
    } catch (err) {
      hideLoading();
      showError('Could not create room. Please try again.');
    }
  });

  // Code inputs behavior
  codeInputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '');
      if (digits.length > 1) {
        // Distribute pasted digits across inputs
        const available = codeInputs.length - index;
        const chunk = digits.slice(0, available);
        chunk.split('').forEach((digit, offset) => {
          codeInputs[index + offset].value = digit;
        });
        const nextIndex = Math.min(index + chunk.length, codeInputs.length - 1);
        focusInput(nextIndex);
      } else {
        input.value = digits;
        if (digits && index < codeInputs.length - 1) {
          focusInput(index + 1);
        }
      }
      maybeJoin();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && index > 0) {
        focusInput(index - 1);
      }
      if (e.key === 'ArrowLeft' && index > 0) {
        focusInput(index - 1);
        e.preventDefault();
      }
      if (e.key === 'ArrowRight' && index < codeInputs.length - 1) {
        focusInput(index + 1);
        e.preventDefault();
      }
      if (e.key === 'Enter') {
        const code = readCode();
        if (/^\d{4}$/.test(code)) {
          joinRoom(code);
        }
      }
    });

    input.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const roomId = extractRoomId(text);
      if (!roomId) return;
      e.preventDefault();
      fillCode(roomId);
      maybeJoin();
    });
  });

  // Auto-fill from URL query param (e.g., ?room=abc123)
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const roomId = extractRoomId(roomParam);
    if (roomId) {
      fillCode(roomId);
      maybeJoin();
    }
  }

  if (codeInputs[0]) {
    codeInputs[0].focus();
  }
})();
