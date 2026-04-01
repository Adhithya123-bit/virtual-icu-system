/* ============================================================
   virtual-icu / public / js / app.js
   Main application logic — all pages, socket events, UI
   ============================================================ */

// ── App State ─────────────────────────────────────────────────
let currentUser    = null;
let socket         = null;
let webrtc         = null;
let wallRTC        = null;  // WallRTC instance for video wall
let currentRoomId  = null;
let callSeconds    = 0;
let timerInterval  = null;
let muted          = false;
let cameraOff      = false;
let sharingScreen  = false;
let pendingReqs    = [];
let allSessions    = [];
let modalReqId     = null;
let toastTimer     = null;

// ── DOM Ready ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSocket();
  // Set today's date as default in visit request form
  const dateInput = document.getElementById('fam-date');
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
});

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO SETUP
// ═══════════════════════════════════════════════════════════════

// Call participants map: socketId → { name, role }
const callParticipants = {};
// Wall patient map: socketId → { patientId, patientName }
const wallPatientMap = {};

function initSocket() {
  socket = io();
  webrtc  = new WebRTCManager(socket);
  wallRTC = new WallRTC(socket);

  socket.on('connect',    () => setSrvStatus(true));
  socket.on('disconnect', () => setSrvStatus(false));

  // ── Non-call events ───────────────────────────────────────
  socket.on('new_visit_request', (data) => {
    pendingReqs.unshift(data);
    renderPendingRequests();
    toast(`📋 New request from ${data.familyName}`, 'info');
  });

  socket.on('visit_approved', ({ session }) => {
    toast('✅ Visit APPROVED!', 'success');
    allSessions.push(session);
    renderFamilySessions();
    // Patient auto-joins when visit is approved
    if (currentUser && currentUser.role === 'patient') {
      autoJoinCall(session.roomId);
    }
  });

  socket.on('visit_denied', () => {
    toast('❌ Visit request not approved.', 'error');
  });

  socket.on('call_started', ({ roomId, patientName, participants }) => {
    if (currentUser && currentUser.role === 'nurse') {
      showNurseCallAlert(roomId, patientName, participants);
      refreshMonitor();
    }
    if (currentUser && currentUser.role === 'patient') {
      // Patient auto-joins when call starts (family joined)
      autoJoinCall(roomId);
    }
  });

  socket.on('patient_access_changed', ({ name, visitAllowed }) => {
    toast(`${visitAllowed?'✅':'🚫'} ${name}: visits ${visitAllowed?'allowed':'restricted'}`, visitAllowed?'success':'warning');
  });

  socket.on('new_handover', ({ note, patientName }) => {
    if (currentUser && note.nurseId !== currentUser.id) {
      toast(`📝 New handover note for ${patientName} by ${note.nurseName}`, 'info');
    }
    const tab = document.getElementById('nurse-tab-handover');
    if (tab && tab.style.display !== 'none') loadHandoverFeed();
  });

  // Nurse changed their shift — refresh nurse assignments if admin is watching
  socket.on('nurse_shift_changed', ({ nurseId, nurseName, shift }) => {
    const shiftIcons = { Morning:'🌅', Afternoon:'🌤️', Night:'🌙', 'On-Call':'📟', 'Day-Off':'🏖️' };
    if (currentUser && currentUser.role === 'admin') {
      toast(`${shiftIcons[shift]||''} ${nurseName} switched to ${shift} shift`, 'info');
      fetch('/api/nurses').then(r=>r.json()).then(nurses => { renderNurseAssignments(nurses); renderShiftOverview(nurses); });
    }
    // If this nurse is me but on another tab/device — sync UI
    if (currentUser && currentUser.id === nurseId) {
      updateShiftLabel(shift);
    }
  });

  // Admin changed shifts in bulk
  socket.on('admin_bulk_shift_changed', ({ assignments }) => {
    if (currentUser && currentUser.role === 'admin') {
      fetch('/api/nurses').then(r=>r.json()).then(nurses => {
        renderNurseAssignments(nurses);
        renderShiftOverview(nurses);
        // Refresh shift manager list if modal open
        const modal = document.getElementById('shift-modal');
        if (modal && modal.style.display !== 'none') {
          _shiftNurseCache = nurses;
          renderShiftManagerList(nurses);
        }
      });
    }
    // If this nurse is in the list, update their own label
    if (currentUser && currentUser.role === 'nurse') {
      const mine = assignments.find(a => a.nurseId === currentUser.id);
      if (mine) updateShiftLabel(mine.shift);
    }
  });

  // Patient was reassigned to a different nurse
  socket.on('patient_reassigned', ({ patientId, patientName, newNurseId, newNurseName }) => {
    if (currentUser && currentUser.role === 'nurse') {
      // If I was the nurse who lost/gained this patient — refresh my monitor
      toast(`👩‍⚕️ ${patientName} reassigned to ${newNurseName}`, 'info');
      refreshMonitor();
    }
    if (currentUser && currentUser.role === 'admin') {
      toast(`👩‍⚕️ ${patientName} → ${newNurseName}`, 'info');
    }
  });

  // Patient camera online — connect immediately if wall is open
  socket.on('patient_camera_online', ({ roomId, patientName, socketId: patientSocketId, userId }) => {
    console.log('[Wall] Patient camera online:', patientName, patientSocketId);
    wallPatientMap[patientSocketId] = { patientName, userId };
    if (currentUser && currentUser.role === 'nurse' && videoWallActive) {
      wallConnectPatientCamera(patientSocketId, userId, patientName);
    }
  });

  // Count of patients that received wall_request_cameras
  socket.on('wall_request_count', ({ count }) => {
    console.log('[Wall] Server sent request to', count, 'patients');
    const status = document.getElementById('video-wall-status');
    if (status && count === 0) {
      status.textContent = (videoWallPatients?.length || 0) + ' patients • No patients online — ask patients to log in';
    }
  });

  // wall_answer and wall_ice are handled by wallRTC._bind() in webrtc.js

  // Patient signals they're ready — nurse sends wall offer to get camera
  socket.on('wall_patient_ready', ({ patientSocketId, patientName, userId }) => {
    console.log('[Wall] Patient ready signal from:', patientName, patientSocketId);
    if (currentUser && currentUser.role === 'nurse' && videoWallActive) {
      wallPatientMap[patientSocketId] = { patientName, userId };
      wallConnectPatientCamera(patientSocketId, userId, patientName);
    }
  });

  // Patient receives nurse's camera request (broadcast)
  socket.on('wall_camera_requested', ({ nurseSocketId }) => {
    console.log('[Patient] Camera requested by nurse:', nurseSocketId);
    if (currentUser && currentUser.role === 'patient') {
      const tryRespond = () => {
        if (window._patientStream) {
          wallRTC.respondWithCamera(nurseSocketId, null, window._patientStream)
            .catch(e => console.warn('[Patient] respondWithCamera err:', e));
          // Actually we need an offer first - signal nurse to send offer
          socket.emit('wall_patient_ready', { nurseSocketId, patientSocketId: socket.id });
        } else {
          setTimeout(tryRespond, 1000);
        }
      };
      tryRespond();
    }
  });

  // ── Call room events ──────────────────────────────────────
  socket.on('room_participants', ({ participants }) => {
    // I just joined — send offer to everyone already in room
    participants.forEach(p => {
      console.log('[Call] Offering to', p.name, p.role);
      addCallParticipant(p.socketId, p.name, p.role);
      webrtc.createOffer(p.socketId);
    });
    updateParticipantCount();
  });

  socket.on('user_joined', ({ socketId, name, role }) => {
    console.log('[Call] Joined:', name, role);
    addCallParticipant(socketId, name, role);
    appendSystemMsg(`${name} (${role}) joined`);
    toast(`${name} joined`, 'success');
    updateParticipantCount();
    // They joined after me — their WebRTC will send ME an offer
  });

  socket.on('user_left', ({ socketId, name }) => {
    appendSystemMsg(`${name || 'Participant'} left`);
    toast(`${name || 'Participant'} left`, 'warning');
    webrtc.removePeer(socketId);
    removeCallParticipant(socketId);
    updateParticipantCount();
  });

  socket.on('call_ended', ({ by }) => {
    toast(`Call ended by ${by}`, 'error');
    leaveCall();
  });

  socket.on('chat_message', ({ message, senderName, socketId: fromId }) => {
    appendChatMsg(message, senderName, fromId === socket.id);
  });

  // Patient receives wall_offer_to_patient from nurse — responds with camera
  socket.on('wall_offer_to_patient', async ({ offer, from }) => {
    console.log('[Patient] Wall offer from nurse', from, '| stream:', !!window._patientStream);
    if (currentUser && currentUser.role === 'patient') {
      const tryRespond = async () => {
        if (window._patientStream) {
          await wallRTC.respondWithCamera(from, offer, window._patientStream);
        } else {
          console.warn('[Patient] Stream not ready, retry in 1s');
          setTimeout(tryRespond, 1000);
        }
      };
      await tryRespond();
    }
  });

  // ── WebRTC callbacks ──────────────────────────────────────
  webrtc.onRemoteStream = (stream, socketId) => {
    console.log('[Call] Stream from', socketId);
    const vid = document.getElementById('vid-' + socketId);
    if (vid) {
      vid.srcObject = stream;
      const overlay = document.getElementById('overlay-' + socketId);
      if (overlay) overlay.style.display = 'none';
    }
  };

  webrtc.onConnected = () => toast('🎥 Video connected!', 'success');

  webrtc.onPeerLeft = (socketId) => removeCallParticipant(socketId);
}

// ── Auto-join: patient joins call automatically ───────────────
async function autoJoinCall(roomId) {
  if (!roomId) return;
  // Don't join if already in a call
  if (currentRoomId === roomId) return;
  console.log('[Patient] Auto-joining call:', roomId);
  await joinRoomById(roomId);
}

// ═══════════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════════
const CREDS = {
  admin:   { email: 'admin@hospital.com',     password: 'admin123'   },
  nurse:   { email: 'kavitha@hospital.com',   password: 'nurse123'   },
  family:  { email: 'icu1family@gmail.com',   password: 'icu1family' },
  patient: { email: 'icu1@gmail.com',         password: 'icu1pass'   }
};

function fillCreds() {
  const role = document.getElementById('role-select').value;
  document.getElementById('login-email').value    = CREDS[role].email;
  document.getElementById('login-password').value = CREDS[role].password;
}

async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errBox   = document.getElementById('login-error');

  // hide previous error
  errBox.style.display = 'none';

  if (!email || !password) {
    errBox.textContent = 'Please enter email and password';
    errBox.style.display = 'block';
    return;
  }

  // Show loading state
  const btn = document.querySelector('#login-form button[type="submit"]');
  if (btn) { btn.textContent = 'Signing in...'; btn.disabled = true; }

  try {
    const data = await API.login(email, password);
    console.log('[LOGIN] Response:', data);

    if (data.error) {
      errBox.textContent = data.error;
      errBox.style.display = 'block';
      if (btn) { btn.textContent = 'Sign In Securely 🔐'; btn.disabled = false; }
      return;
    }

    currentUser = data.user;
    socket.emit('join_as', { role: currentUser.role, userId: currentUser.id, name: currentUser.name });
    // Sync shift selector if nurse
    if (currentUser.role === 'nurse' && currentUser.currentShift) {
      const sel = document.getElementById('nurse-shift-select');
      if (sel) sel.value = currentUser.currentShift;
      updateShiftLabel(currentUser.currentShift);
    }
    await loadDashboard();
    showPage(currentUser.role + '-page');
    toast(`Welcome, ${currentUser.name}! 👋`, 'success');

  } catch (err) {
    console.error('[LOGIN] Network error:', err);
    errBox.textContent = 'Cannot reach server. Is Node.js running on port 3000?';
    errBox.style.display = 'block';
    if (btn) { btn.textContent = 'Sign In Securely 🔐'; btn.disabled = false; }
  }
}

async function doLogout() {
  await API.logout();
  currentUser = null; currentRoomId = null;
  clearInterval(timerInterval);
  showPage('login-page');
}

// ═══════════════════════════════════════════════════════════════
//  LOAD & RENDER DASHBOARD
// ═══════════════════════════════════════════════════════════════
async function loadDashboard() {
  const [stats, patients, sessions, requests] = await Promise.all([
    API.getStats(), API.getPatients(), API.getSessions(), API.getVisitRequests()
  ]);

  allSessions = sessions;
  pendingReqs = requests.filter(r => r.status === 'pending');

  if (currentUser.role === 'admin') {
    document.getElementById('admin-uname').textContent = currentUser.name;
    renderAdminStats(stats);
    const nurses = await fetch('/api/nurses').then(r=>r.json());
    renderPatientTable(patients, nurses);
    renderNurseAssignments(nurses);
    renderShiftOverview(nurses);
    renderAdminSchedule(sessions);
  }
  if (currentUser.role === 'nurse') {
    document.getElementById('nurse-uname').textContent = currentUser.name;
    renderNurseStats(stats);
    renderPendingRequests();
    renderNurseSessions(sessions);
    startMonitorAutoRefresh(); // start live patient monitor
  }
  if (currentUser.role === 'family') {
    document.getElementById('family-uname').textContent = currentUser.name;
    document.getElementById('family-greet').textContent = currentUser.name;
    const myPatient = patients.find(p => p.id === currentUser.patientId);
    if (myPatient) document.getElementById('fam-patient').value = myPatient.name;
    renderFamilySessions(sessions);
  }
  if (currentUser.role === 'patient') {
    document.getElementById('patient-greet').textContent = currentUser.name;
    initPatientRoom(sessions);
  }
}

// ── Admin Renders ─────────────────────────────────────────────
function renderAdminStats(s) {
  document.getElementById('admin-stats').innerHTML = `
    <div class="stat-card"><div class="label">Total Patients</div><div class="value">${s.totalPatients}</div><div class="sub">In ICU</div></div>
    <div class="stat-card"><div class="label">Live Calls</div><div class="value" style="color:var(--success)">${s.activeSessions}</div><div class="sub">Active now</div></div>
    <div class="stat-card"><div class="label">Scheduled</div><div class="value">${s.scheduledToday}</div><div class="sub">Today</div></div>
    <div class="stat-card"><div class="label">Pending</div><div class="value" style="color:var(--accent)">${s.pendingRequests}</div><div class="sub">Requests</div></div>
    <div class="stat-card"><div class="label">Completed</div><div class="value">${s.completedToday}</div><div class="sub">Today</div></div>
  `;
}

function renderPatientTable(patients, nurses=[]) {
  const shiftIcon = { Morning:'🌅', Afternoon:'🌤️', Night:'🌙' };
  const addBtn = `
    <tr id="add-patient-row" style="background:var(--primary-light);">
      <td colspan="8" style="padding:8px 16px;">
        <button class="btn btn-primary" style="font-size:0.8rem" onclick="showAddPatientForm()">
          ＋ Add New Patient
        </button>
      </td>
    </tr>`;

  document.getElementById('patient-tbody').innerHTML = addBtn + patients.map(p => {
    const nurse = nurses.find(n => n.id === p.nurseId || n.userId === p.nurseId);
    const nurseName  = nurse ? nurse.name : '—';
    const nurseShift = nurse ? nurse.currentShift || '—' : '—';
    const shiftBadge = nurse && nurse.currentShift
      ? `<span style="font-size:0.72rem;background:var(--primary-light);color:var(--primary);
           padding:2px 8px;border-radius:10px;font-weight:600;">
           ${shiftIcon[nurse.currentShift] || ''} ${nurse.currentShift}
         </span>`
      : '<span style="color:var(--muted);font-size:0.75rem">—</span>';
    const icuEmail  = `icu${p.icuNumber}@gmail.com`;
    const nurseOpts = nurses.map(n =>
      `<option value="${n.userId||n.id}" ${(n.userId||n.id)===p.nurseId?'selected':''}>
         ${n.name} (${n.assignedPatients?.length||0} pts)
       </option>`).join('');
    return `
    <tr>
      <td>
        <div style="font-weight:700">${p.name}</div>
        <div style="font-size:0.7rem;color:var(--muted)">🛏️ ${icuEmail} / icu${p.icuNumber}pass</div>
        <div style="font-size:0.7rem;color:var(--muted)">👨‍👩‍👧 icu${p.icuNumber}family@gmail.com / icu${p.icuNumber}family</div>
      </td>
      <td>${p.bed}</td>
      <td>${p.ward}</td>
      <td><span class="badge ${p.condition==='Critical'?'badge-red':p.condition==='Stable'?'badge-green':'badge-yellow'}">${p.condition}</span></td>
      <td>
        <div style="font-size:0.82rem;font-weight:600;color:var(--text);margin-bottom:4px">👩‍⚕️ ${nurseName}</div>
        <select onchange="reassignNurse('${p.id}', this.value)"
          style="font-size:0.73rem;padding:3px 6px;border-radius:6px;
                 border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer;">
          ${nurseOpts}
        </select>
      </td>
      <td>${shiftBadge}</td>
      <td><span class="badge ${p.visitAllowed?'badge-green':'badge-red'}">${p.visitAllowed?'✅ Allowed':'🚫 Restricted'}</span></td>
      <td style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn btn-primary" style="padding:5px 10px;font-size:0.75rem" onclick="joinSession('${p.id}')">📹</button>
        <button class="btn btn-outline" style="padding:5px 10px;font-size:0.75rem" onclick="toggleAccess('${p.id}',${!p.visitAllowed})">${p.visitAllowed?'Restrict':'Allow'}</button>
        <button class="btn btn-danger"  style="padding:5px 10px;font-size:0.75rem" onclick="removePatient('${p.id}','${p.name}')">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

function renderNurseAssignments(nurses) {
  const el = document.getElementById('nurse-assignments');
  if (!el) return;
  const shiftColors = {
    Morning:   { bg:'#dcfce7', color:'#166534', icon:'🌅' },
    Afternoon: { bg:'#fef9c3', color:'#92400e', icon:'🌤️' },
    Night:     { bg:'#ede9fe', color:'#4c1d95', icon:'🌙' },
    'On-Call': { bg:'#fee2e2', color:'#991b1b', icon:'📟' },
    'Day-Off': { bg:'#f1f5f9', color:'#475569', icon:'🏖️' }
  };
  el.innerHTML = nurses.map(n => {
    const sc = shiftColors[n.currentShift] || shiftColors.Morning;
    return `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem 1.2rem;margin-bottom:0.8rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.6rem">
        <div>
          <div style="font-weight:600;font-size:0.92rem">${n.name}</div>
          <div style="font-size:0.75rem;color:var(--muted)">${n.email} · ${n.assignedPatients?.length||0} patients</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:0.75rem;font-weight:700;background:${sc.bg};color:${sc.color};
            padding:3px 10px;border-radius:12px;">${sc.icon} ${n.currentShift || 'Morning'} Shift</span>
          <span class="badge badge-blue">Nurse</span>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${(n.assignedPatients||[]).map(p => `
          <span style="font-size:0.72rem;background:var(--primary-light);color:var(--primary);
            padding:3px 9px;border-radius:10px;font-weight:500">
            ${p.bed} · ${p.name}
          </span>`).join('')}
        ${(n.assignedPatients||[]).length===0 ? '<span style="font-size:0.75rem;color:var(--muted)">No patients assigned</span>' : ''}
      </div>
    </div>`;
  }).join('');
}

async function showAddPatientForm() {
  // Fetch nurses for dropdown
  const nurses = await fetch('/api/nurses').then(r=>r.json());
  const nurseOpts = nurses.map(n => `<option value="${n.userId||n.id}">${n.name} (${n.assignedPatients?.length||0} patients)</option>`).join('');

  document.getElementById('modal-title').textContent = '➕ Add New Patient';
  document.getElementById('modal-body').innerHTML = `
    <div class="form-group"><label>Full Name</label>
      <input id="new-p-name" type="text" placeholder="Mr. / Mrs. Patient Name"/></div>
    <div class="form-group"><label>Bed Number</label>
      <input id="new-p-bed" type="text" placeholder="e.g. ICU-7"/></div>
    <div class="form-group"><label>Ward</label>
      <select id="new-p-ward">
        <option>Cardiac ICU</option><option>Neuro ICU</option>
        <option>Surgical ICU</option><option>General ICU</option></select></div>
    <div class="form-group"><label>Condition</label>
      <select id="new-p-condition">
        <option>Stable</option><option>Recovering</option><option>Critical</option></select></div>
    <div class="form-group"><label>Assign Nurse</label>
      <select id="new-p-nurse">${nurseOpts}</select></div>
    <div style="background:var(--primary-light);border-radius:8px;padding:0.8rem;font-size:0.78rem;color:var(--primary);margin-top:0.5rem">
      🔑 Patient login will be auto-created as:<br/>
      <strong>icu[N]@gmail.com / icu[N]pass</strong>
    </div>
  `;
  document.getElementById('modal-row').innerHTML = `
    <button class="btn btn-primary" onclick="submitAddPatient()">✅ Add Patient</button>
    <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
  `;
  document.getElementById('modal').classList.add('open');
}

async function submitAddPatient() {
  const name      = document.getElementById('new-p-name').value.trim();
  const bed       = document.getElementById('new-p-bed').value.trim();
  const ward      = document.getElementById('new-p-ward').value;
  const condition = document.getElementById('new-p-condition').value;
  const nurseId   = document.getElementById('new-p-nurse').value;

  if (!name || !bed) { toast('Name and bed are required', 'error'); return; }

  const res  = await fetch('/api/patients', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, bed, ward, condition, nurseId, visitAllowed: true })
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error, 'error'); return; }

  closeModal();
  toast(`✅ Patient added!\nPatient: ${data.patientLogin.email} / ${data.patientLogin.password}\nFamily: ${data.familyLogin.email} / ${data.familyLogin.password}`, 'success');
  await loadDashboard();
}

async function removePatient(patientId, name) {
  if (!confirm(`Remove ${name} from ICU? This will delete their login, family login, and all sessions.`)) return;
  const res = await fetch(`/api/patients/${patientId}`, { method: 'DELETE' });
  if (res.ok) {
    toast(`${name} removed from system`, 'success');
    await loadDashboard();
  } else {
    toast('Failed to remove patient', 'error');
  }
}

function renderAdminSchedule(sessions) {
  document.getElementById('admin-schedule').innerHTML = sessions.map(s => `
    <div class="slot-card">
      <div class="s-time">
        ${s.status==='live'?'<span class="pulse"></span>':s.status==='scheduled'?'🟡':'⚫'}
        ${s.scheduledTime} · <strong>${s.status.toUpperCase()}</strong>
      </div>
      <div class="s-patient">${s.patient?.name||'Unknown'}</div>
      <div class="s-family">👨‍👩‍👧 ${s.family?.name||'Family'}</div>
      <div class="s-actions">
        ${s.status!=='ended'?`<button class="btn btn-primary" onclick="joinRoomById('${s.roomId}')">Join</button>`:''}
        ${s.status==='ended'?`<span class="badge badge-gray">Ended${s.duration?' · '+s.duration+' min':''}</span>`:''}
      </div>
    </div>
  `).join('');
}

// ── Nurse Renders ─────────────────────────────────────────────
function renderNurseStats(s) {
  document.getElementById('nurse-stats').innerHTML = `
    <div class="stat-card"><div class="label">My Patients</div><div class="value">${s.totalPatients}</div><div class="sub">Assigned to me</div></div>
    <div class="stat-card"><div class="label">Active Calls</div><div class="value" style="color:var(--success)">${s.activeSessions}</div><div class="sub">Live now</div></div>
    <div class="stat-card"><div class="label">Pending</div><div class="value" style="color:var(--accent)">${s.pendingRequests}</div><div class="sub">Approvals</div></div>
    <div class="stat-card"><div class="label">Scheduled</div><div class="value">${s.scheduledToday}</div><div class="sub">Today</div></div>
  `;
}

function renderPendingRequests() {
  const el = document.getElementById('pending-list');
  if (!el) return;
  if (pendingReqs.length === 0) {
    el.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;padding:1rem 0">No pending requests 🎉</p>';
    return;
  }
  el.innerHTML = pendingReqs.map(r => `
    <div class="req-card">
      <div class="r-name">👤 ${r.familyName}</div>
      <div class="r-detail">Patient: <strong>${r.patient?.name||r.patientId}</strong> · ${r.requestedTime}</div>
      ${r.note ? `<div class="r-note">"${r.note}"</div>` : ''}
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="openModal('${r.id}')">Review</button>
      </div>
    </div>
  `).join('');
}

function renderNurseSessions(sessions) {
  const el = document.getElementById('nurse-sessions');
  if (!el) return;
  const active = sessions.filter(s => s.status !== 'ended');
  if (active.length === 0) {
    el.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No active sessions</p>'; return;
  }
  el.innerHTML = active.map(s => `
    <div class="slot-card" style="margin-bottom:0.8rem">
      <div class="s-time">${s.status==='live'?'<span class="pulse"></span>':'🟡'} ${s.scheduledTime} · ${s.status.toUpperCase()}</div>
      <div class="s-patient">${s.patient?.name||'Unknown'}</div>
      <div class="s-family">👨‍👩‍👧 ${s.family?.name||'Family'}</div>
      <div class="s-actions" style="margin-top:8px">
        <button class="btn btn-primary" onclick="joinRoomById('${s.roomId}')">Join Session</button>
      </div>
    </div>
  `).join('');
}

// ── Family Renders ────────────────────────────────────────────
function renderFamilySessions(sessions) {
  const el = document.getElementById('family-sessions');
  if (!el) return;
  const src = sessions || allSessions;
  const mine = src.filter(s => s.familyId === currentUser?.id || s.status !== 'ended').slice(0, 4);
  if (mine.length === 0) {
    el.innerHTML = '<p style="color:var(--muted);font-size:0.83rem">No visits scheduled yet.</p>'; return;
  }
  el.innerHTML = mine.map(s => `
    <div class="upcoming-card">
      <div>
        <div class="u-title">${s.patient?.name||'Patient'}</div>
        <div class="u-detail">${s.scheduledTime} · <span class="badge ${s.status==='scheduled'?'badge-blue':s.status==='live'?'badge-green':'badge-gray'}">${s.status}</span></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
        ${s.status!=='ended'?`<button class="btn btn-primary" onclick="joinRoomById('${s.roomId}')">Join</button>`:''}
      </div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════
//  VISIT REQUEST (Family)
// ═══════════════════════════════════════════════════════════════
async function submitVisitRequest() {
  const note = document.getElementById('fam-note').value;
  const time = document.getElementById('fam-time').value;
  const date = document.getElementById('fam-date').value;

  const { ok, data } = await API.submitVisitRequest({
    patientId:     currentUser.patientId,
    familyId:      currentUser.id,
    familyName:    currentUser.name,
    requestedTime: `${date} · ${time}`,
    note
  });

  if (!ok) { toast(data.error, 'error'); return; }
  toast('✅ Visit request submitted! You will be notified once approved.', 'success');
  document.getElementById('fam-note').value = '';
}

// ═══════════════════════════════════════════════════════════════
//  MODAL — APPROVE / DENY
// ═══════════════════════════════════════════════════════════════
function openModal(reqId) {
  const r = pendingReqs.find(r => r.id === reqId);
  if (!r) return;
  modalReqId = reqId;
  document.getElementById('modal-title').textContent = 'Review Visit Request';
  document.getElementById('modal-body').innerHTML = `
    <p style="font-size:0.87rem;color:var(--muted);margin-bottom:6px">Visitor: <strong style="color:var(--text)">${r.familyName}</strong></p>
    <p style="font-size:0.87rem;color:var(--muted);margin-bottom:6px">Patient: <strong style="color:var(--text)">${r.patient?.name||r.patientId}</strong></p>
    <p style="font-size:0.87rem;color:var(--muted);margin-bottom:6px">Time: <strong style="color:var(--text)">${r.requestedTime}</strong></p>
    ${r.note?`<div style="font-size:0.81rem;font-style:italic;color:#78350f;background:#fffbeb;padding:8px 12px;border-radius:8px;margin-top:8px">"${r.note}"</div>`:''}
  `;
  // Reset modal buttons to approve/deny (in case add patient changed them)
  const row = document.getElementById('modal-row');
  if (row) row.innerHTML = `
    <button class="btn btn-success" onclick="approveReq()">✅ Approve</button>
    <button class="btn btn-danger"  onclick="denyReq()">❌ Deny</button>
    <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
  `;
  document.getElementById('modal').classList.add('open');
}

function closeModal() { document.getElementById('modal').classList.remove('open'); }

async function approveReq() {
  await API.updateVisitRequest(modalReqId, 'approved');
  pendingReqs = pendingReqs.filter(r => r.id !== modalReqId);
  renderPendingRequests();
  closeModal();
  toast('✅ Visit approved! Family notified.', 'success');
}

async function denyReq() {
  await API.updateVisitRequest(modalReqId, 'denied');
  pendingReqs = pendingReqs.filter(r => r.id !== modalReqId);
  renderPendingRequests();
  closeModal();
  toast('Request denied and family notified.', 'warning');
}

// ═══════════════════════════════════════════════════════════════
//  PATIENT ACCESS TOGGLE
// ═══════════════════════════════════════════════════════════════
async function toggleAccess(patientId, allow) {
  await API.toggleVisitAccess(patientId, allow);
  toast(`Visit access ${allow ? 'enabled ✅' : 'restricted 🚫'}`, allow ? 'success' : 'warning');
  const patients = await API.getPatients();
  renderPatientTable(patients);
}

async function joinSession(patientId) {
  const sessions = await API.getSessions();
  const s = sessions.find(s => s.patientId === patientId && s.status !== 'ended');
  if (s) joinRoomById(s.roomId);
  else toast('No active session for this patient yet.', 'warning');
}

// ═══════════════════════════════════════════════════════════════
//  VIDEO CALL — dynamic grid, 2-3 participants
// ═══════════════════════════════════════════════════════════════

let localStream  = null;  // keep reference for screen share restore

// Build a video tile using CSS classes from call.css
function buildVideoTile(videoId, overlayId, name, role, isLocal=false) {
  const avatarColors = {
    nurse:   'background:#1a2a4a;color:#60a5fa',
    family:  'background:#0a2a1a;color:#4ade80',
    patient: 'background:#2a200a;color:#facc15',
    admin:   'background:#2a0a0a;color:#f87171'
  };
  const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const avStyle  = avatarColors[role] || 'background:#1a3a3a;color:#4dd9d9';
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

  const tile = document.createElement('div');
  tile.id        = 'tile-' + videoId;
  tile.className = 'call-tile';

  tile.innerHTML = `
    <video id="${videoId}" autoplay ${isLocal?'muted':''} playsinline></video>
    <div id="${overlayId}" class="tile-overlay">
      <div class="tile-avatar" style="${avStyle}">${initials}</div>
      <p>${isLocal ? 'Starting camera...' : name + ' connecting...'}</p>
    </div>
    <div class="tile-namebar">
      <span>${name} ${isLocal ? '(You)' : '('+roleLabel+')'}</span>
      ${isLocal ? '<span class="tile-live"><span></span>LIVE</span>' : ''}
    </div>
  `;
  return tile;
}

// Relayout grid — uses CSS classes for clean responsive layouts
function relayoutGrid() {
  const grid  = document.getElementById('video-grid');
  if (!grid) return;
  const count = grid.children.length;
  // Remove all layout classes first
  grid.classList.remove('layout-2', 'layout-3');
  grid.classList.add(count <= 2 ? 'layout-2' : 'layout-3');
  // Update participant count
  const badge = document.getElementById('call-participants-count');
  if (badge) badge.textContent = count + ' participant' + (count!==1?'s':'');
}

async function joinRoomById(roomId) {
  if (!roomId) { toast('No room ID', 'error'); return; }
  if (currentRoomId === roomId) return; // already in this room
  currentRoomId = roomId;

  showPage('call-page');
  document.getElementById('chat-msgs').innerHTML = '';

  // Clear grid and build local tile
  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';
  const localTile = buildVideoTile('local-video', 'local-overlay', currentUser.name, currentUser.role, true);
  grid.appendChild(localTile);
  relayoutGrid();

  // Start camera
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:1280}, height:{ideal:720} },
      audio: { echoCancellation:true, noiseSuppression:true }
    });
    webrtc.localStream = localStream;
    const localVid = document.getElementById('local-video');
    localVid.srcObject = localStream;
    document.getElementById('local-overlay').style.display = 'none';
    // Store for patient monitor wall
    window._patientStream = localStream;
  } catch(err) {
    console.warn('[Call] Camera failed:', err.message);
    toast('Camera unavailable — audio only', 'warning');
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
      webrtc.localStream = localStream;
    } catch(e) {}
  }

  // Emit join to server — server will send room_participants
  socket.emit('join_room', {
    roomId,
    userId: currentUser.id,
    role:   currentUser.role,
    name:   currentUser.name
  });

  // Start timer
  callSeconds = 0;
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds/60)).padStart(2,'0');
    const s = String(callSeconds%60).padStart(2,'0');
    document.getElementById('call-timer').textContent = m+':'+s;
  }, 1000);

  appendSystemMsg('Joined secure room. Waiting for others...');
}

function addCallParticipant(socketId, name, role) {
  const grid = document.getElementById('video-grid');
  if (!grid) return;
  // Don't add duplicate
  if (document.getElementById('tile-vid-'+socketId)) return;
  const tile = buildVideoTile('vid-'+socketId, 'overlay-'+socketId, name, role, false);
  grid.appendChild(tile);
  relayoutGrid();
}

function removeCallParticipant(socketId) {
  const tile = document.getElementById('tile-vid-'+socketId);
  if (tile) tile.remove();
  relayoutGrid();
}

function updateParticipantCount() {
  const grid  = document.getElementById('video-grid');
  if (!grid) return;
  const badge = document.getElementById('call-participants-count');
  if (badge) badge.textContent = grid.children.length + ' participant' + (grid.children.length!==1?'s':'');
}

// Patient auto-joins — no button needed
async function autoJoinCall(roomId) {
  if (!roomId || currentRoomId === roomId) return;
  console.log('[Patient] Auto-joining:', roomId);
  await joinRoomById(roomId);
}

function toggleMute() {
  muted = webrtc.toggleAudio();
  document.getElementById('btn-mute').classList.toggle('active', muted);
  toast(muted ? '🔇 Muted' : '🎤 Unmuted', 'info');
}

function toggleCamera() {
  cameraOff = webrtc.toggleVideo();
  document.getElementById('btn-video').classList.toggle('active', cameraOff);
  const ov = document.getElementById('local-overlay');
  if (ov) ov.style.display = cameraOff ? 'flex' : 'none';
  toast(cameraOff ? '📷 Camera off' : '🎥 Camera on', 'info');
}

async function shareScreen() {
  const localVid = document.getElementById('local-video');
  if (!sharingScreen) {
    const ok = await webrtc.startScreenShare(localVid);
    if (ok) { sharingScreen = true; document.getElementById('btn-screen').classList.add('active'); toast('🖥 Sharing screen', 'success'); }
    else toast('Screen sharing cancelled', 'warning');
  } else {
    await webrtc.stopScreenShare(localVid);
    sharingScreen = false;
    document.getElementById('btn-screen').classList.remove('active');
    toast('Screen sharing stopped', 'info');
  }
}

function endCall() {
  socket.emit('end_call', { roomId: currentRoomId, durationSeconds: callSeconds });
  leaveCall();
}

function leaveCall() {
  clearInterval(timerInterval);
  webrtc.hangup();
  localStream = null;

  // Clear the dynamic grid
  const grid = document.getElementById('video-grid');
  if (grid) grid.innerHTML = '';

  // Reset timer and controls
  document.getElementById('call-timer').textContent = '00:00';
  document.getElementById('btn-mute').classList.remove('active');
  document.getElementById('btn-video').classList.remove('active');
  document.getElementById('btn-screen').classList.remove('active');

  currentRoomId = null; muted = false; cameraOff = false; sharingScreen = false;

  showPage(currentUser.role + '-page');
  toast('Call ended 💙', 'info');
}

// ── Chat ──────────────────────────────────────────────────────
function sendChatMsg() {
  const inp = document.getElementById('chat-inp');
  const msg = inp.value.trim();
  if (!msg || !currentRoomId) return;
  socket.emit('chat_message', {
    roomId: currentRoomId, message: msg,
    senderName: currentUser.name, role: currentUser.role
  });
  inp.value = '';
}

function appendChatMsg(message, senderName, isMine) {
  const body = document.getElementById('chat-msgs');
  const t    = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const div  = document.createElement('div');
  div.className = 'chat-msg' + (isMine ? ' mine' : '');
  div.innerHTML = `<div class="c-sender">${senderName} · ${t}</div><div class="c-bubble">${message}</div>`;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

function appendSystemMsg(msg) {
  const body = document.getElementById('chat-msgs');
  if (!body) return;
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = msg;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}

function show(id) { const el = document.getElementById(id); if(el) el.classList.remove('hidden'); }
function hide(id) { const el = document.getElementById(id); if(el) el.classList.add('hidden'); }

function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function setSrvStatus(online) {
  document.getElementById('srv-dot').style.background = online ? '#27ae60' : '#ef4444';
  document.getElementById('srv-text').textContent     = online ? 'Server connected' : 'Disconnected';
}

// ═══════════════════════════════════════════════════════════════
//  NURSE TAB SWITCHING
// ═══════════════════════════════════════════════════════════════
function switchNurseTab(tab) {
  document.querySelectorAll('.nurse-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('nurse-tab-monitor').style.display  = tab === 'monitor'  ? 'block' : 'none';
  document.getElementById('nurse-tab-video').style.display    = tab === 'video'    ? 'flex'  : 'none';
  document.getElementById('nurse-tab-requests').style.display = tab === 'requests' ? 'block' : 'none';
  document.getElementById('nurse-tab-sessions').style.display = tab === 'sessions' ? 'block' : 'none';
  document.getElementById('nurse-tab-handover').style.display = tab === 'handover' ? 'block' : 'none';
  if (tab === 'video')    startVideoWall();
  if (tab === 'handover') loadHandoverFeed();
}

// ═══════════════════════════════════════════════════════════════
//  PATIENT MONITOR
// ═══════════════════════════════════════════════════════════════

// Simulated vitals — in a real system these come from medical devices
function generateVitals(condition) {
  if (condition === 'Critical') {
    return {
      hr:    { val: Math.floor(Math.random() * 30) + 110, unit: 'bpm',  status: 'danger'  },
      bp:    { val: `${Math.floor(Math.random()*20)+150}/${Math.floor(Math.random()*10)+95}`, unit: 'mmHg', status: 'danger' },
      spo2:  { val: Math.floor(Math.random() * 5)  + 88,  unit: '%',    status: 'danger'  },
      temp:  { val: (Math.random() * 1 + 38.5).toFixed(1), unit: '°C',  status: 'warning' },
      rr:    { val: Math.floor(Math.random() * 8)  + 22,  unit: '/min', status: 'warning' },
      bp_mean:{ val: Math.floor(Math.random() * 15) + 60,  unit: 'MAP',  status: 'warning' },
    };
  } else if (condition === 'Stable') {
    return {
      hr:    { val: Math.floor(Math.random() * 20) + 65,  unit: 'bpm',  status: 'normal'  },
      bp:    { val: `${Math.floor(Math.random()*10)+115}/${Math.floor(Math.random()*10)+75}`, unit: 'mmHg', status: 'normal' },
      spo2:  { val: Math.floor(Math.random() * 3)  + 97,  unit: '%',    status: 'normal'  },
      temp:  { val: (Math.random() * 0.4 + 36.6).toFixed(1), unit: '°C', status: 'normal' },
      rr:    { val: Math.floor(Math.random() * 4)  + 14,  unit: '/min', status: 'normal'  },
      bp_mean:{ val: Math.floor(Math.random() * 10) + 85,  unit: 'MAP',  status: 'normal'  },
    };
  } else {
    // Recovering
    return {
      hr:    { val: Math.floor(Math.random() * 20) + 78,  unit: 'bpm',  status: 'normal'  },
      bp:    { val: `${Math.floor(Math.random()*15)+125}/${Math.floor(Math.random()*10)+80}`, unit: 'mmHg', status: 'warning' },
      spo2:  { val: Math.floor(Math.random() * 4)  + 94,  unit: '%',    status: 'warning' },
      temp:  { val: (Math.random() * 0.8 + 37.2).toFixed(1), unit: '°C', status: 'warning' },
      rr:    { val: Math.floor(Math.random() * 5)  + 17,  unit: '/min', status: 'normal'  },
      bp_mean:{ val: Math.floor(Math.random() * 12) + 78,  unit: 'MAP',  status: 'normal'  },
    };
  }
}

function renderMonitorCard(patient, sessions) {
  const v = generateVitals(patient.condition);
  const activeSession = sessions.find(s => s.patientId === patient.id && s.status !== 'ended');
  const isLive = activeSession && activeSession.status === 'live';

  const condBadge = patient.condition === 'Critical'
    ? 'badge-red'
    : patient.condition === 'Stable'
    ? 'badge-green'
    : 'badge-yellow';

  return `
    <div class="monitor-card">
      <div class="monitor-card-header">
        <div>
          <div class="patient-name">${patient.name}</div>
          <div class="patient-bed">${patient.bed} · ${patient.ward}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px">
          <span class="badge ${condBadge}">${patient.condition}</span>
          ${isLive
            ? `<span class="live-indicator"><span class="live-dot-anim"></span>LIVE CALL</span>`
            : activeSession
            ? `<span style="font-size:0.7rem;color:var(--muted)">📅 Scheduled</span>`
            : `<span style="font-size:0.7rem;color:var(--muted)">No visit today</span>`
          }
        </div>
      </div>

      <!-- Vitals grid -->
      <div class="monitor-vitals">
        <div class="vital-box">
          <span class="vital-label">Heart Rate</span>
          <span class="vital-value vital-${v.hr.status}">${v.hr.val}</span>
          <span class="vital-unit">${v.hr.unit}</span>
        </div>
        <div class="vital-box">
          <span class="vital-label">Blood Pressure</span>
          <span class="vital-value vital-${v.bp.status}" style="font-size:1rem">${v.bp.val}</span>
          <span class="vital-unit">${v.bp.unit}</span>
        </div>
        <div class="vital-box">
          <span class="vital-label">SpO₂</span>
          <span class="vital-value vital-${v.spo2.status}">${v.spo2.val}</span>
          <span class="vital-unit">${v.spo2.unit}</span>
        </div>
        <div class="vital-box">
          <span class="vital-label">Temperature</span>
          <span class="vital-value vital-${v.temp.status}">${v.temp.val}</span>
          <span class="vital-unit">${v.temp.unit}</span>
        </div>
        <div class="vital-box">
          <span class="vital-label">Resp. Rate</span>
          <span class="vital-value vital-${v.rr.status}">${v.rr.val}</span>
          <span class="vital-unit">${v.rr.unit}</span>
        </div>
        <div class="vital-box">
          <span class="vital-label">MAP</span>
          <span class="vital-value vital-${v.bp_mean.status}">${v.bp_mean.val}</span>
          <span class="vital-unit">${v.bp_mean.unit}</span>
        </div>
      </div>

      <!-- Footer actions -->
      <div class="monitor-card-footer">
        <span class="visit-status-pill ${patient.visitAllowed ? 'badge-green' : 'badge-red'}">
          ${patient.visitAllowed ? '✅ Visits Allowed' : '🚫 Visits Restricted'}
        </span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          ${activeSession && activeSession.status !== 'ended'
            ? `<button class="btn btn-primary" style="padding:5px 12px;font-size:0.76rem"
                onclick="joinRoomById('${activeSession.roomId}')">📹 Join</button>`
            : ''
          }
          <button class="btn btn-outline" style="padding:5px 12px;font-size:0.76rem"
            onclick="toggleAccessFromMonitor('${patient.id}', ${!patient.visitAllowed})">
            ${patient.visitAllowed ? 'Restrict' : 'Allow'}
          </button>
          <button class="btn btn-outline" style="padding:5px 12px;font-size:0.76rem;color:var(--primary)"
            onclick="openReassignModal('${patient.id}','${patient.name.replace(/'/g,"\\'")}')">
            👩‍⚕️ Reassign
          </button>
        </div>
      </div>
    </div>
  `;
}

async function refreshMonitor() {
  const grid = document.getElementById('patient-monitor-grid');
  const updEl = document.getElementById('monitor-updated');
  if (!grid) return;

  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:2rem;font-size:0.88rem">Loading patient data...</div>`;

  try {
    const [patients, sessions] = await Promise.all([API.getPatients(), API.getSessions()]);
    grid.innerHTML = patients.map(p => renderMonitorCard(p, sessions)).join('');
    const now = new Date();
    updEl.textContent = `Last updated: ${now.toLocaleTimeString()}`;
  } catch (err) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--danger);padding:2rem">Failed to load patients</div>`;
  }
}

async function toggleAccessFromMonitor(patientId, allow) {
  await API.toggleVisitAccess(patientId, allow);
  toast(`Visit access ${allow ? 'enabled ✅' : 'restricted 🚫'}`, allow ? 'success' : 'warning');
  refreshMonitor(); // re-render cards
}

// Auto-refresh every 30 seconds when on monitor tab
let monitorInterval = null;
function startMonitorAutoRefresh() {
  refreshMonitor();
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(() => {
    const monitorTab = document.getElementById('nurse-tab-monitor');
    if (monitorTab && monitorTab.style.display !== 'none') {
      refreshMonitor();
    }
  }, 30000);
}

// ═══════════════════════════════════════════════════════════════
//  NURSE CALL ALERT — popup when patient+family call starts
// ═══════════════════════════════════════════════════════════════
function showNurseCallAlert(roomId, patientName, participants) {
  // Remove any existing alert
  const existing = document.getElementById('nurse-call-alert');
  if (existing) existing.remove();

  const names = participants.map(p => p.name).join(' & ');

  const alert = document.createElement('div');
  alert.id = 'nurse-call-alert';
  alert.innerHTML = `
    <div style="
      position:fixed; bottom:2rem; right:2rem; z-index:9999;
      background:#ffffff; border:2px solid #27ae60;
      border-radius:16px; padding:1.2rem 1.4rem;
      box-shadow:0 8px 32px rgba(0,0,0,0.18);
      max-width:320px; font-family:'DM Sans',sans-serif;
      animation: slideUp 0.3s ease;
    ">
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:0.8rem">
        <div style="width:36px;height:36px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <span style="font-size:1.2rem">📹</span>
        </div>
        <div>
          <div style="font-weight:700;font-size:0.9rem;color:#1a2e2e">Live Call Started!</div>
          <div style="font-size:0.8rem;color:#5a7272;margin-top:2px">
            <strong style="color:#1a2e2e">${patientName}</strong>
          </div>
          <div style="font-size:0.75rem;color:#5a7272;margin-top:2px">
            ${names} are now connected
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="nurseJoinCall('${roomId}')" style="
          flex:1; background:#0a6e6e; color:white;
          border:none; border-radius:8px; padding:8px 12px;
          font-size:0.82rem; font-weight:600; cursor:pointer;
          font-family:inherit;
        ">👁️ Join & Monitor</button>
        <button onclick="document.getElementById('nurse-call-alert').remove()" style="
          background:none; border:1px solid #d8eaea; border-radius:8px;
          padding:8px 12px; font-size:0.82rem; cursor:pointer;
          color:#5a7272; font-family:inherit;
        ">Dismiss</button>
      </div>
      <div style="font-size:0.7rem;color:#9ca3af;margin-top:8px;text-align:center">
        Auto-dismisses in 30 seconds
      </div>
    </div>
    <style>
      @keyframes slideUp {
        from { transform: translateY(20px); opacity:0; }
        to   { transform: translateY(0);    opacity:1; }
      }
    </style>
  `;

  document.body.appendChild(alert);

  // Auto dismiss after 30 seconds
  setTimeout(() => {
    const el = document.getElementById('nurse-call-alert');
    if (el) el.remove();
  }, 30000);
}

function nurseJoinCall(roomId) {
  // Remove the alert
  const alert = document.getElementById('nurse-call-alert');
  if (alert) alert.remove();
  // Join the call room
  joinRoomById(roomId);
}

// Video participant management handled in VIDEO CALL section above

// ═══════════════════════════════════════════════════════════════
//  VIDEO WALL — real webcam (WebRTC) + canvas vitals side by side
//  Nurse sees each assigned patient: LEFT=room camera, RIGHT=vitals
// ═══════════════════════════════════════════════════════════════

let videoWallActive   = false;
let videoWallPatients = [];
let videoWallSessions = [];
let wallAnimIds       = {};   // patientId → animationFrameId
const wallPCs         = {};   // socketId  → RTCPeerConnection (for webcam streams)
// WALL_ICE defined at top of file

const WALL_COLORS = {
  Critical:   { bg: '#2d0a0a', accent: '#ef4444' },
  Stable:     { bg: '#0a2d1a', accent: '#27ae60' },
  Recovering: { bg: '#2d200a', accent: '#f0a500' },
};

async function startVideoWall() {
  const grid   = document.getElementById('video-wall-grid');
  const status = document.getElementById('video-wall-status');
  if (!grid) return;

  // Allow re-opening wall by resetting
  videoWallActive = false;
  Object.values(wallAnimIds).forEach(id => cancelAnimationFrame(id));
  wallAnimIds = {};

  videoWallActive = true;
  if (status) status.textContent = 'Loading patients...';

  try {
    videoWallPatients = await API.getPatients();
    videoWallSessions = await API.getSessions();
    grid.innerHTML = '';

    // Build cells and start vitals for all patients
    videoWallPatients.forEach(p => buildWallCell(p, grid));
    videoWallPatients.forEach(p => startWallVitals(p));

    if (status) status.textContent = videoWallPatients.length + ' patients • Connecting cameras...';

    // Step 1: Fetch online patient sockets from server
    const onlinePatients = await fetch('/api/online-patients').then(r => r.json());
    console.log('[Wall] Online patients:', onlinePatients);

    if (onlinePatients.length === 0) {
      if (status) status.textContent = videoWallPatients.length + ' patients • No patients online yet';
    } else {
      // Step 2: For each online patient, connect their camera
      for (const op of onlinePatients) {
        const patient = videoWallPatients.find(p =>
          p.patientUserId === op.userId || p.name === op.name
        );
        if (patient) {
          console.log('[Wall] Connecting camera:', op.name, op.socketId);
          wallPatientMap[op.socketId] = { patientName: op.name, userId: op.userId };
          await wallConnectPatientCamera(op.socketId, op.userId, op.name);
        }
      }
      if (status) status.textContent = `${videoWallPatients.length} patients • ${onlinePatients.length} camera(s) connecting...`;
    }

    // Step 3: Also broadcast request so any patient we missed will respond
    socket.emit('wall_request_cameras');

  } catch(e) {
    console.error('[Wall] Error:', e);
    if (status) status.textContent = 'Failed to load';
    if (grid) grid.innerHTML = '<div style="color:#8b949e;text-align:center;padding:2rem;grid-column:1/-1">Error loading patients</div>';
    videoWallActive = false;
  }
}

function buildWallCell(patient, grid) {
  const session  = videoWallSessions.find(s => s.patientId === patient.id && s.status !== 'ended');
  const isLive   = session && session.status === 'live';
  const colors   = WALL_COLORS[patient.condition] || WALL_COLORS.Recovering;
  const roomId   = session ? session.roomId : '';
  const cond     = patient.condition;
  const condColor = colors.accent;

  const cell = document.createElement('div');
  cell.id    = 'wall-cell-' + patient.id;
  cell.className = 'wall-cell';
  cell.style.borderColor = condColor + '44';

  cell.innerHTML = `
    <div class="wall-cell-feeds">

      <!-- LEFT: Real camera feed (fills when patient logs in) -->
      <div class="wall-cam" id="wall-cam-${patient.id}">
        <div class="wall-cam-label">ROOM CAM</div>
        <video id="wall-vid-${patient.id}" autoplay muted playsinline
          style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;z-index:1;"></video>
        <div class="wall-cam-overlay" id="wall-cam-overlay-${patient.id}">
          <div style="font-size:1.8rem;">📷</div>
          <div style="font-size:0.68rem;color:#6b7280;text-align:center;padding:0 8px;">
            Waiting for<br/>patient camera
          </div>
        </div>
      </div>

      <!-- RIGHT: Canvas vitals monitor -->
      <div class="wall-vitals">
        <div class="wall-vitals-label">MONITOR</div>
        <canvas id="wall-canvas-${patient.id}" width="240" height="140"
          style="width:100%;height:100%;display:block;"></canvas>
      </div>
    </div>

    <!-- Bottom info bar -->
    <div class="wall-infobar">
      <div>
        <span style="font-size:0.75rem;font-weight:700;color:#f0f0f0;">${patient.name}</span>
        <span style="font-size:0.62rem;color:#9ca3af;margin-left:6px;">${patient.bed}</span>
      </div>
      <div style="display:flex;align-items:center;gap:5px;">
        <span style="font-size:0.6rem;font-weight:700;color:${condColor};
          background:${condColor}22;padding:2px 6px;border-radius:8px;">${cond}</span>
        ${isLive ? `<span style="display:flex;align-items:center;gap:3px;font-size:0.6rem;font-weight:700;color:#27ae60;">
          <span style="width:5px;height:5px;border-radius:50%;background:#27ae60;
            animation:live-pulse 1.4s ease-in-out infinite;display:inline-block;"></span>LIVE</span>` : ''}
        <button onclick="nurseJoinCallFromWall('${roomId}')"
          style="background:${isLive?'#0a6e6e':'#21262d'};color:white;border:none;
            border-radius:5px;padding:2px 8px;font-size:0.6rem;cursor:${isLive?'pointer':'default'};
            font-family:inherit;opacity:${isLive?1:0.4};">
          ${isLive ? 'Join' : 'No call'}</button>
      </div>
    </div>
  `;
  grid.appendChild(cell);
}

function startWallVitals(patient) {
  const canvas = document.getElementById('wall-canvas-' + patient.id);
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  const W = 240, H = 140;
  const colors = WALL_COLORS[patient.condition] || WALL_COLORS.Recovering;
  let frame = Math.floor(Math.random() * 200);
  const speed = patient.condition === 'Critical' ? 3 : patient.condition === 'Stable' ? 1.5 : 2;

  function draw() {
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,W,H);

    // Grid
    ctx.strokeStyle = colors.accent + '15'; ctx.lineWidth = 0.5;
    for(let x=0;x<W;x+=24){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
    for(let y=0;y<H;y+=20){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}

    // ECG line
    const ecgY = H * 0.42;
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for(let x=0;x<W;x++){
      const t = ((x - frame*speed) % W + W) % W;
      const p = (t / W * 5) % 1;
      let y = ecgY;
      if(p<0.05)      y=ecgY-4;
      else if(p<0.08) y=ecgY-14;
      else if(p<0.10) y=ecgY+7;
      else if(p<0.12) y=ecgY-45;
      else if(p<0.15) y=ecgY+22;
      else if(p<0.18) y=ecgY+3;
      if(patient.condition==='Critical') y+=Math.sin(x*0.5+frame*0.07)*4;
      x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.stroke();

    // SpO2 wave
    ctx.strokeStyle='#3b82f6'; ctx.lineWidth=1; ctx.globalAlpha=0.7;
    ctx.beginPath();
    for(let x=0;x<W;x++){
      const y = H*0.75+Math.sin((x/W)*Math.PI*4-frame*0.04)*9;
      x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.stroke(); ctx.globalAlpha=1;

    // Vitals numbers
    const hr   = patient.condition==='Critical'?112+Math.floor(Math.sin(frame*0.03)*6)
               : patient.condition==='Stable'  ? 70+Math.floor(Math.sin(frame*0.015)*3)
               :                                  84+Math.floor(Math.sin(frame*0.02)*4);
    const spo2 = patient.condition==='Critical'?91+Math.floor(Math.sin(frame*0.025)*2)
               : patient.condition==='Stable'  ?98:95+Math.floor(Math.sin(frame*0.02)*1);

    ctx.fillStyle='rgba(0,0,0,0.65)';
    ctx.beginPath(); ctx.roundRect(5,5,62,36,4); ctx.fill();
    ctx.fillStyle=colors.accent; ctx.font='bold 19px monospace'; ctx.fillText(hr,10,29);
    ctx.fillStyle='#9ca3af'; ctx.font='9px sans-serif'; ctx.fillText('HR bpm',10,40);

    ctx.fillStyle='rgba(0,0,0,0.65)';
    ctx.beginPath(); ctx.roundRect(72,5,58,36,4); ctx.fill();
    ctx.fillStyle='#3b82f6'; ctx.font='bold 17px monospace'; ctx.fillText(spo2+'%',77,28);
    ctx.fillStyle='#9ca3af'; ctx.font='9px sans-serif'; ctx.fillText('SpO₂',77,40);

    frame++;
    if(videoWallActive) wallAnimIds[patient.id] = requestAnimationFrame(draw);
  }
  draw();
}

// Nurse connects to patient camera using WallRTC
async function wallConnectPatientCamera(patientSocketId, patientUserId, patientName) {
  const patient = videoWallPatients.find(p =>
    p.name === patientName || p.patientUserId === patientUserId
  );

  if (!patient) {
    console.warn('[Wall] Patient not found in wall list:', patientName, patientUserId);
    // Try refreshing patient list
    videoWallPatients = await API.getPatients();
    const p2 = videoWallPatients.find(p => p.name === patientName || p.patientUserId === patientUserId);
    if (!p2) return;
  }

  const targetPatient = patient || videoWallPatients.find(p =>
    p.name === patientName || p.patientUserId === patientUserId
  );
  if (!targetPatient) return;

  const vid     = document.getElementById('wall-vid-' + targetPatient.id);
  const overlay = document.getElementById('wall-cam-overlay-' + targetPatient.id);

  if (!vid) {
    console.warn('[Wall] No video element wall-vid-' + targetPatient.id);
    return;
  }

  console.log('[Wall] Requesting stream from', patientName, patientSocketId);

  // Use WallRTC to request stream — it handles offer/answer/ICE cleanly
  wallRTC.requestStream(patientSocketId, (stream) => {
    console.log('[Wall] ✅ Stream arrived for', patientName);
    vid.srcObject     = stream;
    vid.style.display = 'block';
    if (overlay) overlay.style.display = 'none';
    const status = document.getElementById('video-wall-status');
    if (status) status.textContent = '✅ ' + patientName + ' camera live';
  });
}

// Patient sends their camera to a specific nurse
async function sendPatientCameraToNurse(nurseSocketId, incomingOffer) {
  if (!window._patientStream) {
    console.warn('[Patient] No stream available yet');
    return;
  }

  const pc = new RTCPeerConnection(WALL_ICE);

  // Add all local video/audio tracks
  window._patientStream.getTracks().forEach(t => {
    pc.addTrack(t, window._patientStream);
  });

  // Send ICE back via wall_ice
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('wall_ice', { to: nurseSocketId, candidate: e.candidate });
    }
  };

  if (incomingOffer) {
    // Responding to a wall_offer
    await pc.setRemoteDescription(new RTCSessionDescription(incomingOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('wall_answer', { to: nurseSocketId, answer });
    console.log('[Patient] Wall answer sent to nurse', nurseSocketId);
  } else {
    // Responding to a wall_camera_requested broadcast — nurse will handle answer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('wall_offer_from_patient', { to: nurseSocketId, offer });
    console.log('[Patient] Wall offer sent to nurse', nurseSocketId);
  }
}

function stopVideoWall() {
  videoWallActive = false;
  Object.values(wallAnimIds).forEach(id => cancelAnimationFrame(id));
  wallAnimIds = {};
  if (wallRTC) wallRTC.closeAll();
  const status = document.getElementById('video-wall-status');
  if (status) status.textContent = 'Stopped';
  const grid = document.getElementById('video-wall-grid');
  if (grid) grid.innerHTML = '<div style="color:#8b949e;text-align:center;padding:3rem;grid-column:1/-1;font-size:0.85rem;">Click ▶ Connect All to resume</div>';
}

function nurseJoinCallFromWall(roomId) {
  if (!roomId) { toast('No active call', 'warning'); return; }
  stopVideoWall();
  switchNurseTab('monitor');
  joinRoomById(roomId);
}

function onCallStartedUpdateWall(data) {
  const tab = document.getElementById('nurse-tab-video');
  if (tab && tab.style.display !== 'none') {
    stopVideoWall();
    videoWallActive = false;
    setTimeout(() => startVideoWall(), 600);
  }
}

// ═══════════════════════════════════════════════════════════════
//  PATIENT ROOM — camera + vitals display

// ═══════════════════════════════════════════════════════════════

let patientVitalsAnimId  = null;
let patientMonitorRoomId = null;

async function initPatientRoom(sessions) {
  // Start patient camera first
  await startPatientCamera();

  // Join a dedicated monitor room so nurse can watch camera
  patientMonitorRoomId = 'monitor-' + currentUser.id;
  socket.emit('join_room', {
    roomId: patientMonitorRoomId,
    userId: currentUser.id,
    role:   'patient',
    name:   currentUser.name
  });

  // Start vitals canvas
  startPatientVitalsCanvas();

  // Render sessions with join button
  renderPatientSessions(sessions);

  // Listen for family joining — show alert to patient
  socket.on('user_joined', ({ name, role }) => {
    if (role === 'family') {
      showPatientCallAlert(name);
    }
  });

  // Listen for visit approved — refresh sessions
  socket.on('visit_approved', () => {
    API.getSessions().then(s => renderPatientSessions(s));
  });
}

function renderPatientSessions(sessions) {
  const el = document.getElementById('patient-sessions');
  if (!el) return;
  const active = sessions.filter(s => s.status !== 'ended');
  if (active.length === 0) {
    el.innerHTML = '<div style="font-size:0.82rem;color:#8b949e;">No visits scheduled yet.</div>';
    return;
  }
  el.innerHTML = active.map(s => {
    const isLive = s.status === 'live';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;
        background:#21262d;border-radius:10px;padding:10px 14px;margin-bottom:8px;
        border:1px solid ${isLive?'#27ae60':'#30363d'};">
        <div>
          <div style="font-size:0.85rem;color:#c9d1d9;font-weight:600;">
            👨‍👩‍👧 ${s.family?.name || 'Family Member'}
          </div>
          <div style="font-size:0.72rem;color:#8b949e;margin-top:2px;">${s.scheduledTime}</div>
        </div>
        <span style="font-size:0.72rem;font-weight:700;padding:4px 12px;border-radius:10px;
          background:${isLive?'rgba(39,174,96,0.2)':'rgba(59,130,246,0.2)'};
          color:${isLive?'#27ae60':'#60a5fa'};">
          ${isLive?'🔴 LIVE — You will be connected':'📅 '+s.status.toUpperCase()}
        </span>
      </div>`;
  }).join('');

  // Auto-join any live session
  const liveSession = active.find(s => s.status === 'live');
  if (liveSession && currentRoomId !== liveSession.roomId) {
    setTimeout(() => autoJoinCall(liveSession.roomId), 500);
  }
}

function showPatientCallAlert(familyName) {
  // Remove existing alert
  const ex = document.getElementById('patient-call-alert');
  if (ex) ex.remove();

  const alert = document.createElement('div');
  alert.id = 'patient-call-alert';
  alert.innerHTML = `
    <div style="
      position:fixed;bottom:2rem;right:2rem;z-index:9999;
      background:#161b22;border:2px solid #27ae60;border-radius:16px;
      padding:1.2rem 1.4rem;max-width:300px;font-family:'DM Sans',sans-serif;
      box-shadow:0 8px 32px rgba(0,0,0,0.4);
    ">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:0.8rem">
        <span style="font-size:1.4rem">👨‍👩‍👧</span>
        <div>
          <div style="font-weight:700;font-size:0.88rem;color:#c9d1d9">${familyName} is here!</div>
          <div style="font-size:0.75rem;color:#8b949e;margin-top:2px">Your family has joined the call</div>
        </div>
      </div>
      <button onclick="patientJoinFromAlert()" style="
        width:100%;background:#27ae60;color:white;border:none;border-radius:8px;
        padding:9px;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit;">
        📹 Join the Call Now
      </button>
    </div>
  `;
  document.body.appendChild(alert);
  setTimeout(() => { const e = document.getElementById('patient-call-alert'); if(e) e.remove(); }, 30000);
}

async function patientJoinFromAlert() {
  const el = document.getElementById('patient-call-alert');
  if (el) el.remove();
  // Find the active session for this patient and join it
  const sessions = await API.getSessions();
  const live = sessions.find(s => s.status === 'live' || s.status === 'scheduled');
  if (live) joinRoomById(live.roomId);
  else toast('No active session found', 'warning');
}

async function startPatientCamera() {
  const video   = document.getElementById('patient-room-video');
  const overlay = document.getElementById('patient-cam-overlay');
  const status  = document.getElementById('patient-cam-status');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
    video.srcObject = stream;
    if (overlay) overlay.style.display = 'none';
    if (status)  status.textContent = '● Live';
    if (status)  status.style.color = '#27ae60';

    // Expose stream so WebRTC can send it to nurse
    window._patientStream = stream;

    return stream;
  } catch(e) {
    if (status)  status.textContent = 'Camera unavailable';
    if (overlay) overlay.innerHTML = `
      <div style="font-size:1.5rem;">📷</div>
      <div style="font-size:0.78rem;color:#8b949e;margin-top:4px">Camera permission denied</div>
    `;
    return null;
  }
}

function startPatientVitalsCanvas() {
  const canvas = document.getElementById('patient-vitals-canvas');
  if (!canvas) return;
  canvas.width  = 500;
  canvas.height = 280;
  const ctx = canvas.getContext('2d');
  let frame = 0;

  function drawVitals() {
    const W = 500, H = 280;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = '#27ae6018';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = 0; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    // ECG line
    const ecgY = H * 0.4;
    ctx.strokeStyle = '#27ae60';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const t = ((x - frame * 2) % W + W) % W;
      const p = (t / W * 6) % 1;
      let y = ecgY;
      if      (p < 0.05)  y = ecgY - 5;
      else if (p < 0.08)  y = ecgY - 20;
      else if (p < 0.10)  y = ecgY + 10;
      else if (p < 0.12)  y = ecgY - 70;
      else if (p < 0.15)  y = ecgY + 35;
      else if (p < 0.18)  y = ecgY + 5;
      else                y = ecgY;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // SpO2 wave
    const spo2Y = H * 0.72;
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const y = spo2Y + Math.sin((x / W) * Math.PI * 5 - frame * 0.05) * 16;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Vitals boxes
    const hr   = 78 + Math.floor(Math.sin(frame * 0.02) * 4);
    const spo2 = 97 + Math.floor(Math.sin(frame * 0.015) * 1);
    const bp   = `${120 + Math.floor(Math.sin(frame*0.01)*5)}/${80 + Math.floor(Math.sin(frame*0.01)*3)}`;

    // HR
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.roundRect(10, 10, 90, 50, 5); ctx.fill();
    ctx.fillStyle = '#27ae60'; ctx.font = 'bold 24px monospace'; ctx.fillText(hr, 18, 43);
    ctx.fillStyle = '#9ca3af'; ctx.font = '10px sans-serif'; ctx.fillText('HR bpm', 18, 55);

    // SpO2
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.roundRect(108, 10, 90, 50, 5); ctx.fill();
    ctx.fillStyle = '#3b82f6'; ctx.font = 'bold 24px monospace'; ctx.fillText(spo2+'%', 116, 43);
    ctx.fillStyle = '#9ca3af'; ctx.font = '10px sans-serif'; ctx.fillText('SpO₂', 116, 55);

    // BP
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.roundRect(206, 10, 110, 50, 5); ctx.fill();
    ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 18px monospace'; ctx.fillText(bp, 214, 40);
    ctx.fillStyle = '#9ca3af'; ctx.font = '10px sans-serif'; ctx.fillText('BP mmHg', 214, 55);

    frame++;
    patientVitalsAnimId = requestAnimationFrame(drawVitals);
  }
  drawVitals();
}

// ═══════════════════════════════════════════════════════════════
//  NURSE CALL ALERT
// ═══════════════════════════════════════════════════════════════
function showNurseCallAlert(roomId, patientName, participants) {
  const existing = document.getElementById('nurse-call-alert');
  if (existing) existing.remove();
  const names  = participants.map(p => p.name).join(' & ');
  const alert  = document.createElement('div');
  alert.id     = 'nurse-call-alert';
  alert.innerHTML = `
    <div style="position:fixed;bottom:2rem;right:2rem;z-index:9999;
      background:#ffffff;border:2px solid #27ae60;border-radius:16px;
      padding:1.2rem 1.4rem;box-shadow:0 8px 32px rgba(0,0,0,0.18);
      max-width:300px;font-family:'DM Sans',sans-serif;">
      <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:0.8rem">
        <div style="width:36px;height:36px;border-radius:50%;background:#dcfce7;
          display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <span style="font-size:1.2rem">📹</span>
        </div>
        <div>
          <div style="font-weight:700;font-size:0.9rem;color:#1a2e2e">Live Call Started!</div>
          <div style="font-size:0.8rem;color:#5a7272;margin-top:2px"><strong>${patientName}</strong></div>
          <div style="font-size:0.75rem;color:#5a7272;margin-top:2px">${names} connected</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="nurseJoinCall('${roomId}')"
          style="flex:1;background:#0a6e6e;color:white;border:none;border-radius:8px;
            padding:8px 12px;font-size:0.82rem;font-weight:600;cursor:pointer;font-family:inherit;">
          👁️ Join & Monitor
        </button>
        <button onclick="document.getElementById('nurse-call-alert').remove()"
          style="background:none;border:1px solid #d8eaea;border-radius:8px;
            padding:8px 12px;font-size:0.82rem;cursor:pointer;color:#5a7272;font-family:inherit;">
          Dismiss
        </button>
      </div>
    </div>`;
  document.body.appendChild(alert);
  setTimeout(() => { const e = document.getElementById('nurse-call-alert'); if(e) e.remove(); }, 30000);
}

function nurseJoinCall(roomId) {
  const a = document.getElementById('nurse-call-alert');
  if (a) a.remove();
  joinRoomById(roomId);
}

function onCallStartedUpdateWall(data) {
  const tab = document.getElementById('nurse-tab-video');
  if (tab && tab.style.display !== 'none') {
    videoWallActive = false;
    setTimeout(() => startVideoWall(), 600);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SHIFT HANDOVER NOTES
// ═══════════════════════════════════════════════════════════════

async function loadHandoverFeed() {
  const feed = document.getElementById('handover-feed');
  if (!feed) return;
  feed.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:1rem 0">Loading...</div>';
  try {
    const notes = await fetch('/api/handovers').then(r => r.json());
    renderHandoverFeed(notes);
  } catch(e) {
    feed.innerHTML = '<div style="color:var(--danger);font-size:0.85rem">Failed to load notes.</div>';
  }
}

function renderHandoverFeed(notes) {
  const feed = document.getElementById('handover-feed');
  if (!feed) return;
  if (!notes || notes.length === 0) {
    feed.innerHTML = `
      <div style="text-align:center;padding:3rem 1rem;color:var(--muted);">
        <div style="font-size:2.5rem;margin-bottom:0.8rem">📋</div>
        <div style="font-size:0.9rem;font-weight:600;margin-bottom:0.3rem">No handover notes yet</div>
        <div style="font-size:0.8rem">Click "＋ New Handover Note" to write the first one for this shift.</div>
      </div>`;
    return;
  }

  const priorityColors = {
    Routine: { bg:'#f0fdf4', border:'#86efac', text:'#166534', label:'🟢 Routine' },
    Watch:   { bg:'#fffbeb', border:'#fcd34d', text:'#92400e', label:'🟡 Watch Closely' },
    Urgent:  { bg:'#fef2f2', border:'#fca5a5', text:'#991b1b', label:'🔴 Urgent' }
  };
  const shiftIcons = { Morning:'🌅', Afternoon:'🌤️', Night:'🌙' };

  // Group by patient
  const grouped = {};
  notes.forEach(n => {
    const key = n.patient?.name || n.patientId;
    if (!grouped[key]) grouped[key] = { patient: n.patient, notes: [] };
    grouped[key].notes.push(n);
  });

  feed.innerHTML = Object.entries(grouped).map(([pName, group]) => {
    const p = group.patient;
    const condBadge = p?.condition === 'Critical' ? 'badge-red'
                    : p?.condition === 'Stable'   ? 'badge-green' : 'badge-yellow';
    return `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;
        margin-bottom:1.2rem;overflow:hidden;">
        <!-- Patient header -->
        <div style="background:var(--primary-light);padding:0.85rem 1.2rem;
          display:flex;align-items:center;justify-content:space-between;
          border-bottom:1px solid var(--border);">
          <div>
            <span style="font-weight:700;font-size:0.95rem;color:var(--primary)">${pName}</span>
            ${p ? `<span style="font-size:0.75rem;color:var(--muted);margin-left:8px">${p.bed} · ${p.ward}</span>` : ''}
          </div>
          ${p ? `<span class="badge ${condBadge}">${p.condition}</span>` : ''}
        </div>
        <!-- Notes for this patient -->
        <div style="padding:0.5rem 0;">
          ${group.notes.map((n, idx) => {
            const pc = priorityColors[n.priority] || priorityColors.Routine;
            const si = shiftIcons[n.shiftType] || '🌅';
            const dt = new Date(n.createdAt);
            const timeStr = dt.toLocaleString('en-IN', { day:'numeric', month:'short',
              hour:'2-digit', minute:'2-digit' });
            return `
              <div style="border-left:3px solid ${pc.border};margin:0.6rem 1.2rem;
                background:${pc.bg};border-radius:0 10px 10px 0;padding:0.9rem 1rem;
                ${idx > 0 ? 'opacity:0.8;' : ''}">
                <!-- Note header -->
                <div style="display:flex;align-items:center;justify-content:space-between;
                  flex-wrap:wrap;gap:6px;margin-bottom:0.7rem;">
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:0.78rem;font-weight:700;background:${pc.border}55;
                      color:${pc.text};padding:2px 10px;border-radius:12px;">${pc.label}</span>
                    <span style="font-size:0.78rem;color:var(--muted)">${si} ${n.shiftType} Shift</span>
                    <span style="font-size:0.75rem;color:var(--muted)">· ${n.nurseName}</span>
                  </div>
                  <span style="font-size:0.72rem;color:var(--muted)">${timeStr}</span>
                </div>
                <!-- Fields grid -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem 1rem;font-size:0.82rem;">
                  ${n.conditionChange ? `<div><span style="font-weight:600;color:var(--text)">Condition: </span><span style="color:var(--muted)">${n.conditionChange}</span></div>` : ''}
                  ${n.lastVitals     ? `<div style="grid-column:1/-1"><span style="font-weight:600;color:var(--text)">📊 Vitals: </span><span style="color:var(--muted)">${n.lastVitals}</span></div>` : ''}
                  ${n.medications    ? `<div style="grid-column:1/-1"><span style="font-weight:600;color:var(--text)">💊 Medications: </span><span style="color:var(--muted)">${n.medications}</span></div>` : ''}
                  ${n.familyUpdates  ? `<div style="grid-column:1/-1"><span style="font-weight:600;color:var(--text)">👨‍👩‍👧 Family: </span><span style="color:var(--muted)">${n.familyUpdates}</span></div>` : ''}
                  ${n.pendingTasks   ? `<div style="grid-column:1/-1;background:rgba(255,255,255,0.6);border-radius:8px;padding:6px 10px;border-left:2px solid ${pc.border}"><span style="font-weight:600;color:${pc.text}">⏰ Tasks for you: </span><span style="color:var(--text)">${n.pendingTasks}</span></div>` : ''}
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

async function openHandoverForm() {
  // Populate patient dropdown with nurse's patients
  const patients = await API.getPatients();
  const sel = document.getElementById('ho-patient');
  sel.innerHTML = patients.map(p =>
    `<option value="${p.id}">${p.name} (${p.bed})</option>`
  ).join('');
  // Clear fields
  ['ho-condition','ho-vitals','ho-meds','ho-family','ho-tasks'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Auto-detect shift from nurse's current shift, fallback to time of day
  const autoShift = currentUser && currentUser.currentShift
    ? currentUser.currentShift
    : (() => {
        const h = new Date().getHours();
        return h >= 6 && h < 14 ? 'Morning' : h >= 14 && h < 22 ? 'Afternoon' : 'Night';
      })();
  document.getElementById('ho-shift').value    = autoShift;
  document.getElementById('ho-priority').value = 'Routine';
  document.getElementById('handover-form-card').style.display = 'block';
  document.getElementById('handover-form-card').scrollIntoView({ behavior:'smooth' });
}

function closeHandoverForm() {
  document.getElementById('handover-form-card').style.display = 'none';
}

async function submitHandover() {
  const patientId       = document.getElementById('ho-patient').value;
  const shiftType       = document.getElementById('ho-shift').value;
  const priority        = document.getElementById('ho-priority').value;
  const conditionChange = document.getElementById('ho-condition').value.trim();
  const lastVitals      = document.getElementById('ho-vitals').value.trim();
  const medications     = document.getElementById('ho-meds').value.trim();
  const familyUpdates   = document.getElementById('ho-family').value.trim();
  const pendingTasks    = document.getElementById('ho-tasks').value.trim();

  if (!conditionChange && !lastVitals && !medications && !pendingTasks) {
    toast('Please fill in at least one field', 'error');
    return;
  }

  const res  = await fetch('/api/handovers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId, shiftType, priority, conditionChange,
      lastVitals, medications, familyUpdates, pendingTasks })
  });
  const data = await res.json();

  if (!res.ok) { toast(data.error || 'Failed to save', 'error'); return; }

  closeHandoverForm();
  toast('✅ Handover note saved!', 'success');
  loadHandoverFeed();
}


// ═══════════════════════════════════════════════════════════════
//  SHIFT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// updateShiftLabel moved to Admin Shift Management section below

async function changeMyShift(shift) {
  if (!currentUser || currentUser.role !== 'nurse') return;
  const res  = await fetch(`/api/nurses/${currentUser.id}/shift`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shift })
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error || 'Failed to update shift', 'error'); return; }
  updateShiftLabel(shift);
  // Also pre-select in the handover form if open
  const hoShift = document.getElementById('ho-shift');
  if (hoShift) hoShift.value = shift;
  toast(`✅ Shift changed to ${shift}`, 'success');
}

// Listen: another nurse changed their shift — refresh nurse assignments panel
// (already handled via nurse_shift_changed socket event below)

// ═══════════════════════════════════════════════════════════════
//  REASSIGN NURSE (from monitor card — nurse and admin both)
// ═══════════════════════════════════════════════════════════════

async function openReassignModal(patientId, patientName) {
  const nurses = await fetch('/api/nurses').then(r => r.json());
  const shiftColors = {
    Morning:   { bg:'#dcfce7', color:'#166534', icon:'🌅' },
    Afternoon: { bg:'#fef9c3', color:'#92400e', icon:'🌤️' },
    Night:     { bg:'#ede9fe', color:'#4c1d95', icon:'🌙' },
    'On-Call': { bg:'#fee2e2', color:'#991b1b', icon:'📟' },
    'Day-Off': { bg:'#f1f5f9', color:'#475569', icon:'🏖️' }
  };

  document.getElementById('modal-title').textContent = `👩‍⚕️ Reassign Nurse — ${patientName}`;
  document.getElementById('modal-body').innerHTML = `
    <p style="font-size:0.85rem;color:var(--muted);margin-bottom:1rem">
      Select a nurse to take over care for <strong style="color:var(--text)">${patientName}</strong>:
    </p>
    <div style="display:flex;flex-direction:column;gap:8px;" id="nurse-pick-list">
      ${nurses.map(n => {
        const sc = shiftColors[n.currentShift] || shiftColors.Morning;
        const pts = (n.assignedPatients || []).length;
        return `
        <label style="display:flex;align-items:center;gap:12px;background:var(--card);
          border:1px solid var(--border);border-radius:10px;padding:10px 14px;cursor:pointer;
          transition:border-color .15s;" onmouseover="this.style.borderColor='var(--primary)'"
          onmouseout="this.style.borderColor='var(--border)'">
          <input type="radio" name="nurse-pick" value="${n.userId||n.id}"
            style="accent-color:var(--primary);width:16px;height:16px;"/>
          <div style="flex:1">
            <div style="font-weight:600;font-size:0.88rem">${n.name}</div>
            <div style="font-size:0.73rem;color:var(--muted)">${pts} patient${pts!==1?'s':''} assigned</div>
          </div>
          <span style="font-size:0.72rem;font-weight:700;padding:3px 10px;border-radius:12px;
            background:${sc.bg};color:${sc.color};">${sc.icon} ${n.currentShift || 'Morning'}</span>
        </label>`;
      }).join('')}
    </div>
  `;
  document.getElementById('modal-row').innerHTML = `
    <button class="btn btn-primary" onclick="confirmReassign('${patientId}')">✅ Confirm Reassign</button>
    <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
  `;
  document.getElementById('modal').classList.add('open');
}

async function confirmReassign(patientId) {
  const selected = document.querySelector('input[name="nurse-pick"]:checked');
  if (!selected) { toast('Please select a nurse', 'error'); return; }
  const nurseId = selected.value;
  const res  = await fetch(`/api/patients/${patientId}/assign-nurse`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nurseId })
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error || 'Failed to reassign', 'error'); return; }
  closeModal();
  toast('✅ Patient reassigned successfully!', 'success');
  // Refresh the view
  if (currentUser.role === 'nurse') {
    refreshMonitor();
  } else {
    const [patients, nurses] = await Promise.all([API.getPatients(), fetch('/api/nurses').then(r=>r.json())]);
    renderPatientTable(patients, nurses);
    renderNurseAssignments(nurses);
  }
}

async function reassignNurse(patientId, nurseId) {
  const res  = await fetch(`/api/patients/${patientId}/assign-nurse`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nurseId })
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error || 'Failed to reassign', 'error'); return; }
  toast('✅ Nurse reassigned!', 'success');
  const [patients, nurses] = await Promise.all([API.getPatients(), fetch('/api/nurses').then(r=>r.json())]);
  renderPatientTable(patients, nurses);
  renderNurseAssignments(nurses);
}

// ═══════════════════════════════════════════════════════════════
//  ADMIN SHIFT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

const SHIFT_CONFIG = {
  Morning:   { bg:'#dcfce7', color:'#166534', border:'#86efac', icon:'🌅', hours:'07:00 – 15:00', label:'Morning' },
  Afternoon: { bg:'#fef9c3', color:'#92400e', border:'#fde68a', icon:'🌤️', hours:'15:00 – 23:00', label:'Afternoon' },
  Night:     { bg:'#ede9fe', color:'#4c1d95', border:'#c4b5fd', icon:'🌙', hours:'23:00 – 07:00', label:'Night' },
  'On-Call': { bg:'#fee2e2', color:'#991b1b', border:'#fca5a5', icon:'📟', hours:'Available 24h',  label:'On-Call' },
  'Day-Off': { bg:'#f1f5f9', color:'#475569', border:'#cbd5e1', icon:'🏖️', hours:'Off duty',       label:'Day-Off' }
};

// Pending changes in the shift manager modal (nurseId → shift)
let _pendingShiftChanges = {};
let _shiftNurseCache     = [];
let _demoRunning         = false;

// ── Render the shift overview cards on the admin dashboard ──
function renderShiftOverview(nurses) {
  const el = document.getElementById('shift-overview');
  if (!el) return;

  // Group nurses by shift
  const byShift = {};
  nurses.forEach(n => {
    const s = n.currentShift || 'Morning';
    if (!byShift[s]) byShift[s] = [];
    byShift[s].push(n);
  });

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:1rem;">
      ${Object.entries(SHIFT_CONFIG).map(([shift, cfg]) => {
        const group = byShift[shift] || [];
        return `
        <div style="background:${cfg.bg};border:1.5px solid ${cfg.border};border-radius:12px;padding:1rem;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
            <span style="font-size:1.1rem;">${cfg.icon}</span>
            <div>
              <div style="font-weight:700;font-size:0.88rem;color:${cfg.color};">${cfg.label} Shift</div>
              <div style="font-size:0.68rem;color:${cfg.color};opacity:0.75;">${cfg.hours}</div>
            </div>
            <span style="margin-left:auto;background:${cfg.color};color:#fff;border-radius:20px;
              padding:2px 9px;font-size:0.72rem;font-weight:700;">${group.length}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${group.length === 0
              ? `<span style="font-size:0.72rem;color:${cfg.color};opacity:0.6;">No nurses assigned</span>`
              : group.map(n => `
                <div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.6);
                  border-radius:7px;padding:4px 8px;">
                  <span style="font-size:0.75rem;font-weight:600;color:${cfg.color};">${n.name}</span>
                  <span style="font-size:0.65rem;color:${cfg.color};opacity:0.7;margin-left:auto;">
                    ${n.assignedPatients?.length || 0} pts
                  </span>
                </div>`).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

// ── Open the Shift Manager modal ──
async function openShiftManager() {
  _pendingShiftChanges = {};
  const modal = document.getElementById('shift-modal');
  modal.style.display = 'flex';

  const nurses = await fetch('/api/nurses').then(r => r.json());
  _shiftNurseCache = nurses;
  renderShiftManagerList(nurses);
}

function closeShiftModal() {
  document.getElementById('shift-modal').style.display = 'none';
  _pendingShiftChanges = {};
  _demoRunning = false;
}

// ── Render the per-nurse shift selector rows in the modal ──
function renderShiftManagerList(nurses) {
  const el = document.getElementById('shift-manager-list');
  if (!el) return;

  el.innerHTML = nurses.map(n => {
    const currentShift = _pendingShiftChanges[n.userId || n.id] || n.currentShift || 'Morning';
    const cfg = SHIFT_CONFIG[currentShift] || SHIFT_CONFIG.Morning;

    return `
    <div id="smrow-${n.userId||n.id}" style="background:var(--card);border:1.5px solid ${cfg.border};
      border-radius:12px;padding:0.9rem 1.1rem;transition:all 0.3s ease;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <!-- Avatar -->
        <div style="width:38px;height:38px;border-radius:50%;background:${cfg.bg};
          display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">
          👩‍⚕️
        </div>
        <!-- Name & info -->
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:0.9rem;">${n.name}</div>
          <div style="font-size:0.72rem;color:var(--muted);">${n.email} · ${n.assignedPatients?.length||0} patients</div>
        </div>
        <!-- Shift badge -->
        <div id="smrow-badge-${n.userId||n.id}" style="font-size:0.75rem;font-weight:700;
          background:${cfg.bg};color:${cfg.color};border:1px solid ${cfg.border};
          border-radius:20px;padding:3px 12px;white-space:nowrap;">
          ${cfg.icon} ${cfg.label}
        </div>
        <!-- Shift selector -->
        <select onchange="onShiftRowChange('${n.userId||n.id}', this.value)"
          style="border:1.5px solid var(--border);border-radius:8px;padding:5px 10px;
          font-size:0.8rem;background:var(--bg);color:var(--text);cursor:pointer;min-width:130px;">
          ${Object.entries(SHIFT_CONFIG).map(([s,c]) =>
            `<option value="${s}" ${currentShift===s?'selected':''}>${c.icon} ${c.label}</option>`
          ).join('')}
        </select>
        <!-- Instant save button -->
        <button onclick="saveOneShift('${n.userId||n.id}','${n.name}')"
          style="background:var(--primary);color:#fff;border:none;border-radius:8px;
          padding:6px 14px;font-size:0.78rem;cursor:pointer;font-weight:600;white-space:nowrap;">
          Apply
        </button>
      </div>
      <!-- Patients impacted -->
      ${(n.assignedPatients||[]).length > 0 ? `
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;">
        ${n.assignedPatients.map(p => `
          <span style="font-size:0.68rem;background:${cfg.bg};color:${cfg.color};
            border-radius:8px;padding:2px 8px;">${p.bed} · ${p.name}</span>
        `).join('')}
      </div>` : ''}
    </div>`;
  }).join('');
}

// ── Called when a shift dropdown changes ──
function onShiftRowChange(nurseId, newShift) {
  _pendingShiftChanges[nurseId] = newShift;
  const cfg = SHIFT_CONFIG[newShift] || SHIFT_CONFIG.Morning;

  // Update the row border color live
  const row = document.getElementById(`smrow-${nurseId}`);
  if (row) {
    row.style.borderColor = cfg.border;
    row.style.background  = `color-mix(in srgb, ${cfg.bg} 15%, var(--card))`;
  }
  // Update the badge
  const badge = document.getElementById(`smrow-badge-${nurseId}`);
  if (badge) {
    badge.style.background = cfg.bg;
    badge.style.color      = cfg.color;
    badge.style.border     = `1px solid ${cfg.border}`;
    badge.textContent      = `${cfg.icon} ${cfg.label}`;
  }
}

// ── Save one nurse's shift immediately ──
async function saveOneShift(nurseId, nurseName) {
  const shift = _pendingShiftChanges[nurseId];
  if (!shift) { toast('No change pending for this nurse', 'info'); return; }

  const res  = await fetch(`/api/admin/nurses/${nurseId}/shift`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shift })
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error || 'Failed to update shift', 'error'); return; }

  const cfg = SHIFT_CONFIG[shift];
  toast(`✅ ${nurseName} → ${cfg.icon} ${shift} shift saved!`, 'success');
  delete _pendingShiftChanges[nurseId];

  // Refresh overview
  const nurses = await fetch('/api/nurses').then(r => r.json());
  _shiftNurseCache = nurses;
  renderNurseAssignments(nurses);
  renderShiftOverview(nurses);
}

// ── Save ALL pending changes at once ──
async function saveAllShifts() {
  const assignments = Object.entries(_pendingShiftChanges).map(([nurseId, shift]) => ({ nurseId, shift }));
  if (assignments.length === 0) { toast('No pending changes to save', 'info'); return; }

  const res  = await fetch('/api/admin/shifts/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments })
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error || 'Bulk save failed', 'error'); return; }

  toast(`✅ ${data.updated} nurse shift${data.updated!==1?'s':''} updated!`, 'success');
  _pendingShiftChanges = {};
  closeShiftModal();

  const nurses = await fetch('/api/nurses').then(r => r.json());
  renderNurseAssignments(nurses);
  renderShiftOverview(nurses);
}

// ── Apply quick presets ──
async function applyPreset(preset) {
  const nurses = _shiftNurseCache;
  if (!nurses.length) return;

  const shiftOrder = ['Morning','Afternoon','Night','On-Call'];

  nurses.forEach((n, i) => {
    let shift;
    if      (preset === 'day')    shift = 'Morning';
    else if (preset === 'night')  shift = 'Night';
    else if (preset === 'oncall') shift = i % 2 === 0 ? 'On-Call' : 'Morning';
    else if (preset === 'rotate') shift = shiftOrder[i % shiftOrder.length];
    else shift = 'Morning';

    _pendingShiftChanges[n.userId || n.id] = shift;
    // Update the select
    const row = document.getElementById(`smrow-${n.userId||n.id}`);
    if (row) {
      const sel = row.querySelector('select');
      if (sel) { sel.value = shift; onShiftRowChange(n.userId||n.id, shift); }
    }
  });

  toast('⚡ Preset applied — click "Save All Changes" to confirm', 'info');
}

// ── Auto Demo: cycles through shifts to showcase real-time updates ──
async function runShiftDemo() {
  if (_demoRunning) { toast('Demo already running…', 'info'); return; }
  _demoRunning = true;

  const nurses = _shiftNurseCache;
  if (!nurses.length) { _demoRunning = false; return; }

  const demoSequence = [
    { preset: 'day',    label: 'Setting all nurses to Morning shift...'    },
    { preset: 'rotate', label: 'Rotating shifts across the team...'        },
    { preset: 'night',  label: 'Night coverage — moving all to Night...'   },
    { preset: 'oncall', label: 'On-Call mode — 24/7 coverage active...'    },
    { preset: 'rotate', label: 'Final rotation — balancing the team...'    },
  ];

  toast('🎬 Demo starting! Watch the shifts change live...', 'info');

  for (const step of demoSequence) {
    if (!_demoRunning) break;
    toast(`🔄 ${step.label}`, 'info');
    await applyPreset(step.preset);
    await saveAllShifts_silent();
    await sleep(2200);
  }

  _demoRunning = false;
  toast('🎬 Demo complete! Shifts are updated in real-time across all devices.', 'success');
}

// Save without closing modal (used by demo)
async function saveAllShifts_silent() {
  const assignments = Object.entries(_pendingShiftChanges).map(([nurseId, shift]) => ({ nurseId, shift }));
  if (!assignments.length) return;
  await fetch('/api/admin/shifts/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments })
  });
  _pendingShiftChanges = {};
  // Refresh shift list inside modal without closing
  const nurses = await fetch('/api/nurses').then(r => r.json());
  _shiftNurseCache = nurses;
  renderShiftManagerList(nurses);
  renderNurseAssignments(nurses);
  renderShiftOverview(nurses);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Update shift icons for extended shift types (On-Call, Day-Off) ──
function updateShiftLabel(shift) {
  const icons = { Morning:'🌅', Afternoon:'🌤️', Night:'🌙', 'On-Call':'📟', 'Day-Off':'🏖️' };
  const label = document.getElementById('nurse-shift-label');
  if (label) label.textContent = (icons[shift] || '') + ' ' + shift;
  const sel = document.getElementById('nurse-shift-select');
  if (sel) sel.value = shift;
  if (currentUser) currentUser.currentShift = shift;
}

