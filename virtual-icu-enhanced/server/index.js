// ============================================================
//  virtual-icu / server / index.js
//  Full backend: Express + MongoDB + Socket.IO + HTTPS
// ============================================================

const express        = require('express');
const https          = require('https');
const http           = require('http');
const { Server }     = require('socket.io');
const cors           = require('cors');
const session        = require('express-session');
const { v4: uuidv4 } = require('uuid');
const path           = require('path');
const mongoose       = require('mongoose');
const selfsigned     = require('selfsigned');
const os             = require('os');

// ── Get local WiFi IP ──────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ── Self-signed SSL cert ───────────────────────────────────
const localIP = getLocalIP();
const pems    = selfsigned.generate(
  [{ name: 'commonName', value: localIP }],
  { days: 365, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [
      { type: 7, ip: localIP },
      { type: 7, ip: '127.0.0.1' },
      { type: 2, value: 'localhost' }
    ]}]
  }
);

const app         = express();
const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);
const httpServer  = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  res.writeHead(301, { Location: `https://${host}:3443${req.url}` });
  res.end();
});
const io = new Server(httpsServer, { cors: { origin: '*', methods: ['GET','POST'] } });

// ── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: 'virtual-icu-secret-2024',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: true, sameSite: 'none' }
}));

// ============================================================
//  SCHEMAS
// ============================================================
const UserSchema = new mongoose.Schema({
  userId:       { type: String, unique: true },
  name:         String,
  role:         String,                          // admin | nurse | family | patient
  email:        { type: String, lowercase: true, trim: true, unique: true },
  password:     String,
  patientId:    { type: String, default: null }, // for family & patient roles
  nurseId:      { type: String, default: null }, // for nurse role
  currentShift: { type: String, enum: ['Morning','Afternoon','Night','On-Call','Day-Off'], default: 'Morning' } // active shift for nurses
});

const PatientSchema = new mongoose.Schema({
  icuNumber:    { type: Number, unique: true }, // 1,2,3... → icu1@gmail.com
  name:         String,
  bed:          String,
  ward:         String,
  condition:    { type: String, enum: ['Critical','Stable','Recovering'], default: 'Stable' },
  visitAllowed: { type: Boolean, default: true },
  nurseId:      String,                         // assigned nurse userId
  familyId:     { type: String, default: null },// linked family userId
  patientUserId:{ type: String, default: null } // linked patient userId
});

const VisitRequestSchema = new mongoose.Schema({
  patientId:     String,
  familyId:      String,
  familyName:    String,
  requestedTime: String,
  note:          String,
  status:        { type: String, default: 'pending' },
  createdAt:     { type: Date, default: Date.now }
});

const ICUSessionSchema = new mongoose.Schema({
  patientId:     String,
  familyId:      String,
  scheduledTime: String,
  status:        { type: String, default: 'scheduled' },
  roomId:        String,
  duration:      { type: Number, default: null },
  createdAt:     { type: Date, default: Date.now }
});

const ShiftHandoverSchema = new mongoose.Schema({
  patientId:       String,
  nurseId:         String,
  nurseName:       String,
  shiftType:       { type: String, enum: ['Morning','Afternoon','Night'], default: 'Morning' },
  conditionChange: String,
  lastVitals:      String,
  medications:     String,
  familyUpdates:   String,
  pendingTasks:    String,
  priority:        { type: String, enum: ['Routine','Watch','Urgent'], default: 'Routine' },
  createdAt:       { type: Date, default: Date.now }
});

const User            = mongoose.model('User',            UserSchema);
const Patient         = mongoose.model('Patient',         PatientSchema);
const VisitRequest    = mongoose.model('VisitRequest',    VisitRequestSchema);
const ICUSession      = mongoose.model('ICUSession',      ICUSessionSchema);
const ShiftHandover   = mongoose.model('ShiftHandover',   ShiftHandoverSchema);

function toJSON(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : doc;
  obj.id = obj._id.toString();
  delete obj._id; delete obj.__v;
  return obj;
}

// ============================================================
//  SEED DATABASE — clean fresh data every restart
// ============================================================
async function seedDatabase() {
  // Always wipe and reseed everything cleanly
  await User.deleteMany({});
  await Patient.deleteMany({});
  await VisitRequest.deleteMany({});
  await ICUSession.deleteMany({});
  await ShiftHandover.deleteMany({});

  // Auto-detect shift from current server time
  const hour = new Date().getHours();
  const autoShift = hour >= 6 && hour < 14 ? 'Morning'
                  : hour >= 14 && hour < 22 ? 'Afternoon'
                  : 'Night';

  // ── Nurses (3 nurses, each assigned specific patients) ────
  await User.insertMany([
    { userId:'admin1', name:'Admin',          role:'admin',  email:'admin@hospital.com',    password:'admin123',  currentShift: autoShift },
    { userId:'nurse1', name:'Nurse Kavitha',  role:'nurse',  email:'kavitha@hospital.com',  password:'nurse123',  currentShift: autoShift },
    { userId:'nurse2', name:'Nurse Preethi',  role:'nurse',  email:'preethi@hospital.com',  password:'nurse123',  currentShift: hour >= 14 && hour < 22 ? 'Morning' : 'Afternoon' },
    { userId:'nurse3', name:'Nurse Anitha',   role:'nurse',  email:'anitha@hospital.com',   password:'nurse123',  currentShift: 'Night' },
  ]);

  // ── Patients (each gets icuNumber → icu1@gmail.com etc) ──
  const patientsData = [
    { icuNumber:1, name:'Mr. Ramesh Kumar',  bed:'ICU-1', ward:'Cardiac ICU',  condition:'Recovering', visitAllowed:true,  nurseId:'nurse1' },
    { icuNumber:2, name:'Mrs. Lakshmi Devi', bed:'ICU-2', ward:'Neuro ICU',    condition:'Critical',   visitAllowed:false, nurseId:'nurse1' },
    { icuNumber:3, name:'Mr. Arjun Sharma',  bed:'ICU-3', ward:'Surgical ICU', condition:'Stable',     visitAllowed:true,  nurseId:'nurse2' },
    { icuNumber:4, name:'Mrs. Sunita Patel', bed:'ICU-4', ward:'Cardiac ICU',  condition:'Critical',   visitAllowed:false, nurseId:'nurse2' },
    { icuNumber:5, name:'Mr. Vijay Mehta',   bed:'ICU-5', ward:'General ICU',  condition:'Recovering', visitAllowed:true,  nurseId:'nurse3' },
    { icuNumber:6, name:'Mrs. Rekha Singh',  bed:'ICU-6', ward:'Neuro ICU',    condition:'Stable',     visitAllowed:true,  nurseId:'nurse3' },
  ];
  const patients = await Patient.insertMany(patientsData);

  // ── Patient logins → icu1@gmail.com / icu1pass ────────────
  const patientUsers = patients.map(p => ({
    userId:    `patient${p.icuNumber}`,
    name:      p.name,
    role:      'patient',
    email:     `icu${p.icuNumber}@gmail.com`,
    password:  `icu${p.icuNumber}pass`,
    patientId: p._id.toString()
  }));
  await User.insertMany(patientUsers);

  // Link patientUserId back to Patient
  for (const p of patients) {
    await Patient.updateOne(
      { _id: p._id },
      { patientUserId: `patient${p.icuNumber}` }
    );
  }

  // ── Family logins → icu1family@gmail.com / icu1family ────
  // One family per patient (linked to patients 1,3,5,6)
  const familyPairs = [
    { idx:0, name:'Priya Ramesh'  },
    { idx:2, name:'Suresh Sharma' },
    { idx:4, name:'Meera Mehta'   },
    { idx:5, name:'Ravi Singh'    },
  ];
  for (const fp of familyPairs) {
    const p   = patients[fp.idx];
    const n   = p.icuNumber;
    const uid = `family${n}`;
    await User.create({
      userId:    uid,
      name:      fp.name,
      role:      'family',
      email:     `icu${n}family@gmail.com`,
      password:  `icu${n}family`,
      patientId: p._id.toString()
    });
    await Patient.updateOne({ _id: p._id }, { familyId: uid });
  }

  // Print all credentials
  console.log('\n[DB] ✅ Database seeded. All credentials:\n');
  console.log('  ADMIN:');
  console.log('    admin@hospital.com / admin123');
  console.log('\n  NURSES:');
  console.log('    kavitha@hospital.com / nurse123  → ICU-1, ICU-2');
  console.log('    preethi@hospital.com / nurse123  → ICU-3, ICU-4');
  console.log('    anitha@hospital.com  / nurse123  → ICU-5, ICU-6');
  console.log('\n  PATIENTS:');
  patients.forEach(p => {
    console.log(`    icu${p.icuNumber}@gmail.com / icu${p.icuNumber}pass  → ${p.name} (${p.bed})`);
  });
  console.log('\n  FAMILY:');
  console.log('    icu1family@gmail.com / icu1family  → Mr. Ramesh Kumar (ICU-1)');
  console.log('    icu3family@gmail.com / icu3family  → Mr. Arjun Sharma (ICU-3)');
  console.log('    icu5family@gmail.com / icu5family  → Mr. Vijay Mehta  (ICU-5)');
  console.log('    icu6family@gmail.com / icu6family  → Mrs. Rekha Singh  (ICU-6)\n');
}

// ============================================================
//  AUTH ROUTES
// ============================================================
app.post('/api/login', async (req, res) => {
  try {
    const email    = (req.body.email    || '').trim().toLowerCase();
    const password = (req.body.password || '').trim();
    console.log(`[LOGIN] ${email}`);
    const user = await User.findOne({ email, password });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId   = user.userId;
    req.session.userRole = user.role;
    console.log(`[LOGIN] OK → ${user.name} (${user.role})`);
    res.json({ success: true, user: {
      id: user.userId, name: user.name, role: user.role,
      email: user.email, patientId: user.patientId
    }});
  } catch(err) {
    console.error('[LOGIN] Error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  const uid = req.session.userId;
  if (!uid) return res.status(401).json({ error: 'Not logged in' });
  const user = await User.findOne({ userId: uid });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.userId, name: user.name, role: user.role, email: user.email,
             patientId: user.patientId, currentShift: user.currentShift });
});

// Nurse updates their own shift
app.patch('/api/nurses/:id/shift', async (req, res) => {
  try {
    const { shift } = req.body;
    if (!['Morning','Afternoon','Night'].includes(shift))
      return res.status(400).json({ error: 'Invalid shift' });
    const user = await User.findOneAndUpdate(
      { userId: req.params.id },
      { currentShift: shift },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'Nurse not found' });
    // Broadcast to all nurses so their dashboards refresh
    io.to('nurses').emit('nurse_shift_changed', {
      nurseId: req.params.id, nurseName: user.name, shift
    });
    res.json({ success: true, shift });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// Admin changes any nurse's shift
app.patch('/api/admin/nurses/:id/shift', async (req, res) => {
  try {
    const { shift } = req.body;
    const VALID_SHIFTS = ['Morning','Afternoon','Night','On-Call','Day-Off'];
    if (!VALID_SHIFTS.includes(shift))
      return res.status(400).json({ error: 'Invalid shift' });
    const user = await User.findOneAndUpdate(
      { userId: req.params.id, role: 'nurse' },
      { currentShift: shift },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'Nurse not found' });
    // Broadcast to all nurses so their dashboards refresh
    io.to('nurses').emit('nurse_shift_changed', {
      nurseId: req.params.id, nurseName: user.name, shift
    });
    io.emit('admin_shift_changed', { nurseId: req.params.id, nurseName: user.name, shift });
    res.json({ success: true, shift, nurseName: user.name });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// Admin bulk shift assignment
app.post('/api/admin/shifts/bulk', async (req, res) => {
  try {
    const { assignments } = req.body; // [{ nurseId, shift }]
    const results = [];
    for (const { nurseId, shift } of assignments) {
      const VALID_SHIFTS = ['Morning','Afternoon','Night','On-Call','Day-Off'];
      if (!VALID_SHIFTS.includes(shift)) continue;
      const user = await User.findOneAndUpdate(
        { userId: nurseId, role: 'nurse' },
        { currentShift: shift },
        { new: true }
      );
      if (user) {
        results.push({ nurseId, nurseName: user.name, shift });
        io.to('nurses').emit('nurse_shift_changed', { nurseId, nurseName: user.name, shift });
      }
    }
    io.emit('admin_bulk_shift_changed', { assignments: results });
    res.json({ success: true, updated: results.length, assignments: results });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/debug/users', async (req, res) => {
  const users = await User.find({}, 'email password role name -_id');
  res.json({ count: users.length, users });
});

// ============================================================
//  PATIENT ROUTES
// ============================================================
app.get('/api/patients', async (req, res) => {
  const uid  = req.session.userId;
  const user = uid ? await User.findOne({ userId: uid }) : null;
  let query  = {};
  // Nurses only see their assigned patients
  if (user && user.role === 'nurse') {
    query = { nurseId: uid };
  }
  const patients = await Patient.find(query).sort({ icuNumber: 1 });
  res.json(patients.map(toJSON));
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    const p = await Patient.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(toJSON(p));
  } catch { res.status(400).json({ error: 'Invalid ID' }); }
});

// Admin: Add new patient
app.post('/api/patients', async (req, res) => {
  try {
    const { name, bed, ward, condition, nurseId, visitAllowed } = req.body;

    // Get next ICU number
    const last = await Patient.findOne().sort({ icuNumber: -1 });
    const icuNumber = (last ? last.icuNumber : 0) + 1;

    // Create patient record
    const patient = await Patient.create({
      icuNumber, name, bed, ward,
      condition: condition || 'Stable',
      visitAllowed: visitAllowed !== false,
      nurseId: nurseId || 'nurse1'
    });

    // Auto-create patient login: icu<N>@gmail.com / icu<N>pass
    await User.create({
      userId:    `patient${icuNumber}`,
      name,
      role:      'patient',
      email:     `icu${icuNumber}@gmail.com`,
      password:  `icu${icuNumber}pass`,
      patientId: patient._id.toString()
    });
    await Patient.updateOne({ _id: patient._id }, { patientUserId: `patient${icuNumber}` });

    // Auto-create family login: icu<N>family@gmail.com / icu<N>family
    await User.create({
      userId:    `family${icuNumber}`,
      name:      `Family of ${name}`,
      role:      'family',
      email:     `icu${icuNumber}family@gmail.com`,
      password:  `icu${icuNumber}family`,
      patientId: patient._id.toString()
    });
    await Patient.updateOne({ _id: patient._id }, { familyId: `family${icuNumber}` });

    io.to('nurses').emit('patient_added', { patient: toJSON(patient) });

    res.status(201).json({
      success: true,
      patient: toJSON(patient),
      patientLogin: { email: `icu${icuNumber}@gmail.com`,       password: `icu${icuNumber}pass`   },
      familyLogin:  { email: `icu${icuNumber}family@gmail.com`, password: `icu${icuNumber}family` }
    });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// Admin: Remove patient (also removes linked users)
app.delete('/api/patients/:id', async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Not found' });

    // Remove linked patient user, family user, sessions, requests
    await User.deleteOne({ userId: patient.patientUserId });
    await User.deleteOne({ userId: patient.familyId });
    await ICUSession.deleteMany({ patientId: req.params.id });
    await VisitRequest.deleteMany({ patientId: req.params.id });
    await Patient.findByIdAndDelete(req.params.id);

    io.to('nurses').emit('patient_removed', { patientId: req.params.id, name: patient.name });
    res.json({ success: true });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// Toggle visit access
app.patch('/api/patients/:id/visit-access', async (req, res) => {
  try {
    const p = await Patient.findByIdAndUpdate(
      req.params.id, { visitAllowed: req.body.visitAllowed }, { new: true }
    );
    io.to('nurses').emit('patient_access_changed', { patientId: req.params.id, visitAllowed: req.body.visitAllowed, name: p.name });
    res.json({ success: true, patient: toJSON(p) });
  } catch { res.status(400).json({ error: 'Invalid ID' }); }
});

// Update patient details
app.patch('/api/patients/:id', async (req, res) => {
  try {
    const p = await Patient.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, patient: toJSON(p) });
  } catch { res.status(400).json({ error: 'Invalid ID' }); }
});

// ============================================================
//  NURSES
// ============================================================
app.get('/api/nurses', async (req, res) => {
  const nurses = await User.find({ role: 'nurse' }, '-password');
  const result = await Promise.all(nurses.map(async n => {
    const assigned = await Patient.find({ nurseId: n.userId }).sort({ icuNumber: 1 });
    return { ...toJSON(n), currentShift: n.currentShift, assignedPatients: assigned.map(toJSON) };
  }));
  res.json(result);
});

// Reassign nurse to patient (admin or nurse)
app.patch('/api/patients/:id/assign-nurse', async (req, res) => {
  try {
    const p = await Patient.findByIdAndUpdate(
      req.params.id, { nurseId: req.body.nurseId }, { new: true }
    );
    const newNurse = await User.findOne({ userId: req.body.nurseId });
    io.to('nurses').emit('patient_reassigned', {
      patientId:    req.params.id,
      patientName:  p.name,
      newNurseId:   req.body.nurseId,
      newNurseName: newNurse ? newNurse.name : 'Unknown'
    });
    res.json({ success: true, patient: toJSON(p) });
  } catch { res.status(400).json({ error: 'Invalid ID' }); }
});

// ============================================================
//  FAMILY ROUTES
// ============================================================
// Admin: Add family member for a patient
app.post('/api/family', async (req, res) => {
  try {
    const { name, email, password, patientId } = req.body;

    // Check patient doesn't already have a family
    const patient = await Patient.findById(patientId);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    if (patient.familyId) return res.status(400).json({ error: 'Patient already has a family member linked' });

    const userId = 'family' + Date.now();
    const family = await User.create({ userId, name, role: 'family', email: email.toLowerCase(), password, patientId });
    await Patient.updateOne({ _id: patientId }, { familyId: userId });

    res.status(201).json({ success: true, family: toJSON(family) });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// ============================================================
//  VISIT REQUEST ROUTES
// ============================================================
app.get('/api/visit-requests', async (req, res) => {
  const reqs = await VisitRequest.find();
  const enriched = await Promise.all(reqs.map(async r => {
    const obj = toJSON(r);
    try { obj.patient = toJSON(await Patient.findById(obj.patientId)); } catch { obj.patient = null; }
    return obj;
  }));
  res.json(enriched);
});

app.post('/api/visit-requests', async (req, res) => {
  try {
    const patient = await Patient.findById(req.body.patientId);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    if (!patient.visitAllowed) return res.status(403).json({ error: 'Visits not permitted for this patient' });
    const newReq = await VisitRequest.create({
      patientId: req.body.patientId, familyId: req.body.familyId,
      familyName: req.body.familyName, requestedTime: req.body.requestedTime,
      note: req.body.note, status: 'pending'
    });
    io.to('nurses').emit('new_visit_request', { ...toJSON(newReq), patient: toJSON(patient) });
    res.status(201).json({ success: true, request: toJSON(newReq) });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

app.patch('/api/visit-requests/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const vr = await VisitRequest.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!vr) return res.status(404).json({ error: 'Not found' });
    if (status === 'approved') {
      const newSession = await ICUSession.create({
        patientId: vr.patientId, familyId: vr.familyId,
        scheduledTime: vr.requestedTime, status: 'scheduled',
        roomId: 'room-' + uuidv4().slice(0,8)
      });
      io.to('family-' + vr.familyId).emit('visit_approved', { request: toJSON(vr), session: toJSON(newSession) });
      return res.json({ success: true, request: toJSON(vr), session: toJSON(newSession) });
    }
    io.to('family-' + vr.familyId).emit('visit_denied', { request: toJSON(vr) });
    res.json({ success: true, request: toJSON(vr) });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// ============================================================
//  SESSION ROUTES
// ============================================================
app.get('/api/sessions', async (req, res) => {
  const uid  = req.session.userId;
  const user = uid ? await User.findOne({ userId: uid }) : null;
  let query  = {};

  // Patient sees only their own sessions
  if (user && user.role === 'patient' && user.patientId) {
    query = { patientId: user.patientId };
  }
  // Family sees only their patient's sessions
  if (user && user.role === 'family' && user.patientId) {
    query = { patientId: user.patientId };
  }
  // Nurse sees only their assigned patients' sessions
  if (user && user.role === 'nurse') {
    const myPatients = await Patient.find({ nurseId: uid }, '_id');
    query = { patientId: { $in: myPatients.map(p => p._id.toString()) } };
  }

  const sessions = await ICUSession.find(query).sort({ createdAt: -1 });
  const enriched = await Promise.all(sessions.map(async s => {
    const obj = toJSON(s);
    try { obj.patient = toJSON(await Patient.findById(obj.patientId)); } catch { obj.patient = null; }
    const f = await User.findOne({ userId: obj.familyId });
    obj.family = f ? { name: f.name, email: f.email } : null;
    return obj;
  }));
  res.json(enriched);
});

app.get('/api/sessions/room/:roomId', async (req, res) => {
  const s = await ICUSession.findOne({ roomId: req.params.roomId });
  if (!s) return res.status(404).json({ error: 'Not found' });
  const obj = toJSON(s);
  try { obj.patient = toJSON(await Patient.findById(obj.patientId)); } catch { obj.patient = null; }
  res.json(obj);
});

app.patch('/api/sessions/:id/status', async (req, res) => {
  try {
    const update = { status: req.body.status };
    if (req.body.duration) update.duration = req.body.duration;
    const s = await ICUSession.findByIdAndUpdate(req.params.id, update, { new: true });
    res.json({ success: true, session: toJSON(s) });
  } catch { res.status(400).json({ error: 'Invalid ID' }); }
});

// ============================================================
//  STATS
// ============================================================
app.get('/api/stats', async (req, res) => {
  const uid  = req.session.userId;
  const user = uid ? await User.findOne({ userId: uid }) : null;
  // Nurses see stats only for their patients
  let patientFilter = {};
  if (user && user.role === 'nurse') patientFilter = { nurseId: uid };

  // Get patient IDs for this nurse (for session/request filtering)
  const myPatients = user && user.role === 'nurse'
    ? (await Patient.find(patientFilter, '_id')).map(p => p._id.toString())
    : null;

  const sessionFilter  = myPatients ? { patientId: { $in: myPatients } } : {};
  const requestFilter  = myPatients ? { patientId: { $in: myPatients } } : {};

  const [totalPatients, activeSessions, scheduledToday, pendingRequests, completedToday] = await Promise.all([
    Patient.countDocuments(patientFilter),
    ICUSession.countDocuments({ ...sessionFilter, status: 'live' }),
    ICUSession.countDocuments({ ...sessionFilter, status: 'scheduled' }),
    VisitRequest.countDocuments({ ...requestFilter, status: 'pending' }),
    ICUSession.countDocuments({ ...sessionFilter, status: 'ended' }),
  ]);
  res.json({ totalPatients, activeSessions, scheduledToday, pendingRequests, completedToday });
});

// ============================================================
//  SHIFT HANDOVER ROUTES
// ============================================================
// Get handover notes for a patient (last 3 shifts)
app.get('/api/handovers/:patientId', async (req, res) => {
  try {
    const notes = await ShiftHandover.find({ patientId: req.params.patientId })
      .sort({ createdAt: -1 }).limit(3);
    res.json(notes.map(toJSON));
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// Get all handovers for this nurse's patients
app.get('/api/handovers', async (req, res) => {
  try {
    const uid  = req.session.userId;
    const user = uid ? await User.findOne({ userId: uid }) : null;
    let patientFilter = {};
    if (user && user.role === 'nurse') patientFilter = { nurseId: uid };
    const patients = await Patient.find(patientFilter, '_id');
    const pIds = patients.map(p => p._id.toString());
    const notes = await ShiftHandover.find({ patientId: { $in: pIds } })
      .sort({ createdAt: -1 }).limit(20);
    const enriched = await Promise.all(notes.map(async n => {
      const obj = toJSON(n);
      try { obj.patient = toJSON(await Patient.findById(obj.patientId)); } catch { obj.patient = null; }
      return obj;
    }));
    res.json(enriched);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Create a new handover note
app.post('/api/handovers', async (req, res) => {
  try {
    const uid  = req.session.userId;
    const user = uid ? await User.findOne({ userId: uid }) : null;
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const note = await ShiftHandover.create({
      patientId:       req.body.patientId,
      nurseId:         uid,
      nurseName:       user.name,
      shiftType:       req.body.shiftType  || 'Morning',
      conditionChange: req.body.conditionChange || '',
      lastVitals:      req.body.lastVitals      || '',
      medications:     req.body.medications     || '',
      familyUpdates:   req.body.familyUpdates   || '',
      pendingTasks:    req.body.pendingTasks     || '',
      priority:        req.body.priority        || 'Routine',
    });
    // Notify all nurses in real-time
    const patient = await Patient.findById(req.body.patientId);
    io.to('nurses').emit('new_handover', { note: toJSON(note), patientName: patient ? patient.name : 'Unknown' });
    res.status(201).json({ success: true, note: toJSON(note) });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', port: 3443 }));

// Nurse gets list of currently online patients with their socketIds
app.get('/api/online-patients', (req, res) => {
  const online = [];
  for (const [uid, sid] of Object.entries(patientSockets)) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.connected) {
      online.push({ userId: uid, socketId: sid, name: s.data.name });
    } else {
      delete patientSockets[uid]; // cleanup stale entries
    }
  }
  res.json(online);
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ============================================================
//  SOCKET.IO
// ============================================================
const rooms = {};
// Registry: userId → socketId (for patients logged in)
const patientSockets = {};  // userId → socketId

io.on('connection', (socket) => {
  socket.on('join_as', ({ role, userId, name }) => {
    socket.data.role = role; socket.data.userId = userId; socket.data.name = name;
    if (role === 'nurse' || role === 'admin') socket.join('nurses');
    if (role === 'family')  socket.join('family-' + userId);
    if (role === 'patient') {
      socket.join('patient-' + userId);
      patientSockets[userId] = socket.id;
      console.log('[Registry] Patient registered:', name, socket.id);
    }
    socket.emit('joined', { socketId: socket.id });
  });

  socket.on('join_room', async ({ roomId, userId, role, name }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    if (!rooms[roomId]) rooms[roomId] = { participants: [] };
    rooms[roomId].participants.push({ socketId: socket.id, userId, role, name });
    const others = rooms[roomId].participants.filter(p => p.socketId !== socket.id);
    socket.emit('room_participants', { participants: others, roomId });
    socket.to(roomId).emit('user_joined', { socketId: socket.id, userId, role, name });
    if (role === 'patient') {
      io.to('nurses').emit('patient_camera_online', { roomId, patientName: name, socketId: socket.id, userId });
    }
    if (rooms[roomId].participants.length >= 2) {
      const session = await ICUSession.findOne({ roomId });
      let patientName = 'Unknown';
      if (session) {
        try { const p = await Patient.findById(session.patientId); if (p) patientName = p.name; } catch(e) {}
        await ICUSession.updateOne({ roomId }, { status: 'live' });
      }
      io.to('nurses').emit('call_started', {
        roomId, patientName,
        participants: rooms[roomId].participants.map(p => ({ name: p.name, role: p.role }))
      });
    }
  });

  // Regular call offer
  socket.on('webrtc_offer', ({ to, offer }) => {
    io.to(to).emit('webrtc_offer', { offer, from: socket.id });
  });

  // Nurse → Patient: send offer to get patient camera
  socket.on('wall_offer_to_patient', ({ to, offer }) => {
    console.log('[Server] wall_offer_to_patient:', socket.id, '→', to);
    io.to(to).emit('wall_offer_to_patient', { offer, from: socket.id });
  });

  // Patient → Nurse: send offer (response to wall_camera_requested)
  socket.on('wall_offer_from_patient', ({ to, offer }) => {
    console.log('[Server] wall_offer_from_patient:', socket.id, '→', to);
    io.to(to).emit('wall_offer_from_patient', { offer, from: socket.id });
  });

  // Answer (both directions)
  socket.on('wall_answer', ({ to, answer }) => {
    io.to(to).emit('wall_answer', { answer, from: socket.id });
  });

  // ICE (both directions)
  socket.on('wall_ice', ({ to, candidate }) => {
    io.to(to).emit('wall_ice', { candidate, from: socket.id });
  });

  // Patient is ready — tell nurse to send wall_offer_to_patient
  socket.on('wall_patient_ready', ({ nurseSocketId, patientSocketId }) => {
    console.log('[Server] Patient ready, telling nurse to offer:', nurseSocketId, patientSocketId);
    io.to(nurseSocketId).emit('wall_patient_ready', { patientSocketId: socket.id, patientName: socket.data.name, userId: socket.data.userId });
  });

  // Nurse requests all online patient cameras
  socket.on('wall_request_cameras', () => {
    console.log('[Wall] Nurse', socket.id, 'requesting cameras from all patients');
    let count = 0;
    for (const [uid, sid] of Object.entries(patientSockets)) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.connected) {
        console.log('[Wall] → requesting from', s.data.name, sid);
        s.emit('wall_camera_requested', { nurseSocketId: socket.id });
        count++;
      }
    }
    socket.emit('wall_request_count', { count });
    console.log(`[Wall] Requested from ${count} patients`);
  });

  socket.on('webrtc_answer',        ({ to, answer })    => io.to(to).emit('webrtc_answer',        { answer,    from: socket.id }));
  socket.on('webrtc_ice_candidate', ({ to, candidate }) => io.to(to).emit('webrtc_ice_candidate', { candidate, from: socket.id }));

  socket.on('chat_message', ({ roomId, message, senderName, role }) => {
    io.to(roomId).emit('chat_message', { message, senderName, role, timestamp: new Date().toISOString(), socketId: socket.id });
  });

  socket.on('end_call', ({ roomId }) => {
    io.to(roomId).emit('call_ended', { by: socket.data.name });
    delete rooms[roomId];
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].participants = rooms[roomId].participants.filter(p => p.socketId !== socket.id);
      socket.to(roomId).emit('user_left', { socketId: socket.id, name: socket.data.name });
      if (rooms[roomId].participants.length === 0) delete rooms[roomId];
    }
    // Remove from patient registry
    if (socket.data.role === 'patient' && socket.data.userId) {
      delete patientSockets[socket.data.userId];
      console.log('[Registry] Patient disconnected:', socket.data.name);
    }
  });
});

// ============================================================
//  START
// ============================================================
const MONGO_URI  = 'mongodb://127.0.0.1:27017/virtual_icu';
const HTTPS_PORT = 3443;
const HTTP_PORT  = 3000;

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('[DB] ✅ MongoDB connected');
    await seedDatabase();
    httpsServer.listen(HTTPS_PORT, () => {
      const ip = getLocalIP();
      console.log('\n╔══════════════════════════════════════════════════════╗');
      console.log('║   🏥  Virtual ICU — Server Started (HTTPS)           ║');
      console.log('╠══════════════════════════════════════════════════════╣');
      console.log(`║   Your device  →  https://localhost:${HTTPS_PORT}          ║`);
      console.log(`║   WiFi devices →  https://${ip}:${HTTPS_PORT}       ║`);
      console.log('║   ⚠️  Click "Advanced → Proceed" on security warning  ║');
      console.log('╚══════════════════════════════════════════════════════╝\n');
    });
    httpServer.listen(HTTP_PORT, () => {
      console.log(`[HTTP] :${HTTP_PORT} → redirecting to HTTPS :${HTTPS_PORT}`);
    });
  })
  .catch(err => {
    console.error('[DB] ❌ MongoDB failed:', err.message);
    process.exit(1);
  });
