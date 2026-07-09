/**
 * DhishaAI LMS v3.0 — Multi-Admin Architecture
 *
 * ROLES:
 *   superadmin  — sees everything, manages all admins and courses
 *   admin       — owns specific courses, sees only their enrolled students
 *   student     — sees all their courses in one place (across multiple admins)
 *
 * KEY RULES:
 *   - Each course has an ownerId (the admin who created it)
 *   - Admins can only see/edit students enrolled in THEIR courses
 *   - Admins can only see/edit their OWN courses
 *   - Students see ALL courses they're enrolled in regardless of which admin owns them
 *   - Super Admin sees and can do everything
 */

const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const morgan  = require('morgan');
const { v4: uuidv4 } = require('uuid');
const store   = require('./db');   // SQLite persistence layer (with JSON fallback)
const ai      = require('./ai');   // Claude-powered AI Tutor + Playground (key stays server-side)

require('dotenv').config();

const app        = express();
const PORT       = process.env.PORT || 9000;
const JWT_SECRET = process.env.JWT_SECRET || 'dhishaai-lms-secret-v3-2025';
const DB_PATH    = path.join(__dirname, 'dhishaai_lms.json');
const CLIENT_DIST = path.join(__dirname, '../client/dist');

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
// Only log requests that error (4xx/5xx) — keeps the terminal quiet under heavy
// traffic while still surfacing problems.
app.use(morgan('dev', { skip: (req, res) => res.statusCode < 400 }));

// ─── DATABASE ────────────────────────────────────────────────────────────────
let DB = {
  users: [],        // { id, email, password, role, name, createdAt }
  admins: [],       // { id, userId, name, email, subject, phone, createdAt }
  courses: [],      // { id, ownerId(adminId), title, category, ... }
  students: [],     // { id, userId, name, email, batchId, xp, streak, ... }
  enrollments: [],  // { id, studentId, courseId, enrolledAt }
  quizzes: [],      // { id, courseId, title, questions[] }
  quiz_results: [], // { id, studentId, quizId, courseId, score, total }
  progress: [],     // { id, studentId, courseId, percent }
  notifications: [],
  assignments: [],
  materials: [],    // { id, type, courseId, batchId, adminId, adminName, title, description, fileData, fileName, fileType, fileSize, pinned, createdAt }
  topics: [],       // { id, courseId, adminId, order, title, duration, createdAt }
  forum_posts: [],
  batches: [],
  authorities: [],  // { id, userId, name, email, batchIds[], phone, createdAt } — read-only batch monitors
};

function loadDB() {
  // Prefer SQLite; fall back to the JSON file if the native module can't load.
  if (store.init()) {
    try {
      if (store.isEmpty()) {
        // Fresh database — import existing JSON data (or seed), then move file blobs out.
        if (fs.existsSync(DB_PATH)) {
          try { DB = { ...DB, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) }; }
          catch (e) { console.error('JSON import failed:', e.message); }
        }
        if (!DB.admins) DB.admins = [];
        if (!DB.authorities) DB.authorities = [];
        if (!Array.isArray(DB.users) || DB.users.length === 0) seedDB();
        migrateMaterialFilesOut();
        store.persist(DB);
        console.log('✅ SQLite ready — imported existing data into', store.DB_FILE);
      } else {
        DB = { ...DB, ...store.loadAll() };
        if (!DB.admins) DB.admins = [];
        if (!DB.authorities) DB.authorities = [];
        console.log('✅ Database loaded from SQLite:', store.DB_FILE);
      }
      return;
    } catch (e) {
      console.error('SQLite load error, falling back to JSON:', e.message);
    }
  } else {
    console.warn('⚠️  better-sqlite3 unavailable — using JSON file storage. Run "npm install" on the server to enable SQLite.');
  }

  // ── JSON fallback (original behavior) ──
  try {
    if (fs.existsSync(DB_PATH)) {
      const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      DB = { ...DB, ...saved };
      if (!DB.admins) DB.admins = [];
      if (!DB.authorities) DB.authorities = [];
      console.log('✅ Database loaded from', DB_PATH);
    } else {
      seedDB();
    }
  } catch (e) {
    console.error('DB load error, re-seeding:', e.message);
    seedDB();
  }
}

// Persist changes. With SQLite, writes are debounced (bursts coalesce into one
// atomic transaction, off the request path). Without it, we do an atomic
// temp-file + rename JSON write so a crash can't corrupt the file.
let _saveTimer = null;
function saveDB() {
  if (store.available) {
    if (_saveTimer) return; // a flush is already scheduled
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      try { store.persist(DB); } catch (e) { console.error('SQLite persist error:', e.message); }
    }, 400);
    return;
  }
  try {
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
    fs.renameSync(tmp, DB_PATH);
  } catch (e) { console.error('DB save error:', e.message); }
}

// Force any pending debounced write to disk immediately (used on shutdown).
function flushDB() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try { if (store.available) store.persist(DB); } catch (e) { console.error('SQLite flush error:', e.message); }
}

// One-time: move base64 file blobs embedded in materials out of RAM into the
// files table, so the in-memory model / snapshots stay small at scale.
function migrateMaterialFilesOut() {
  if (!store.available || !Array.isArray(DB.materials)) return;
  let moved = 0;
  DB.materials.forEach(m => {
    if (m && m.fileData) {
      store.putFile(m.id, m.fileData, m.fileName, m.fileType);
      m.hasFile = true;
      m.fileData = null;
      moved++;
    }
  });
  if (moved) console.log(`✅ Moved ${moved} file blob(s) out of the DB into the files table`);
}

function seedDB() {
  console.log('🌱 Seeding multi-admin database...');

  DB.batches = [
    { id: 'B2025-01', name: 'Batch Jan 2025', startDate: '15 Jan 2025' },
    { id: 'B2025-06', name: 'Batch Jun 2025', startDate: '01 Jun 2025' },
    { id: 'B2025-07', name: 'Batch Jul 2025', startDate: '01 Jul 2025' },
  ];

  // ── Super Admin ──
  const superPw = bcrypt.hashSync('superadmin123', 10);
  const superUid = uuidv4();
  DB.users = [
    { id: superUid, email: 'superadmin@dhishaai.com', password: superPw, role: 'superadmin', name: 'Super Admin', createdAt: new Date().toISOString() },
  ];
  DB.admins = [];

  // ── Course Admins ──
  const adminDefs = [
    { name: 'Priya Mehta',    email: 'priya@dhishaai.com',    subject: 'Python', pw: 'python123'  },
    { name: 'Ravi Kumar',     email: 'ravi@dhishaai.com',     subject: 'SQL',    pw: 'sql123'     },
    { name: 'Divya Sharma',   email: 'divya@dhishaai.com',    subject: 'BI',     pw: 'powerbi123' },
    { name: 'Anil Reddy',     email: 'anil@dhishaai.com',     subject: 'ML',     pw: 'ml123'      },
    { name: 'Suma Nair',      email: 'suma@dhishaai.com',     subject: 'Excel',  pw: 'excel123'   },
  ];

  const adminIds = [];
  adminDefs.forEach((a, i) => {
    const uid = uuidv4();
    const aid = `ADM-${String(i+1).padStart(3,'0')}`;
    DB.users.push({ id: uid, email: a.email, password: bcrypt.hashSync(a.pw, 10), role: 'admin', name: a.name, createdAt: new Date().toISOString() });
    DB.admins.push({ id: aid, userId: uid, name: a.name, email: a.email, subject: a.subject, phone: '', createdAt: new Date().toISOString() });
    adminIds.push({ aid, uid, subject: a.subject });
  });

  // ── Courses (each owned by a specific admin) ──
  DB.courses = [
    { id: 1, ownerId: adminIds[0].aid, title: 'Python for Data Analytics', category: 'Python', lessons: 24, duration: '10 hrs', color: '#4F46E5', syllabusUnlocked: true,  quizEnabled: true,  description: 'Master Python from basics to advanced data analysis using Pandas, NumPy and Matplotlib.' },
    { id: 2, ownerId: adminIds[1].aid, title: 'SQL for Data Analysis',     category: 'SQL',    lessons: 18, duration: '8 hrs',  color: '#0EA5E9', syllabusUnlocked: true,  quizEnabled: true,  description: 'Write powerful SQL queries to extract, transform and analyse data from relational databases.' },
    { id: 3, ownerId: adminIds[2].aid, title: 'Power BI Masterclass',      category: 'BI',     lessons: 20, duration: '9 hrs',  color: '#F59E0B', syllabusUnlocked: true,  quizEnabled: false, description: 'Build stunning interactive dashboards and business intelligence reports in Power BI.' },
    { id: 4, ownerId: adminIds[3].aid, title: 'Machine Learning Basics',   category: 'ML',     lessons: 30, duration: '15 hrs', color: '#10B981', syllabusUnlocked: false, quizEnabled: false, description: 'Understand supervised and unsupervised ML algorithms and build your first models.' },
    { id: 5, ownerId: adminIds[4].aid, title: 'Excel for Analytics',       category: 'Excel',  lessons: 15, duration: '6 hrs',  color: '#EC4899', syllabusUnlocked: true,  quizEnabled: true,  description: 'Master Excel formulas, pivot tables, and charts for professional data reporting.' },
  ];

  // ── Students (enrolled across courses from different admins) ──
  const studentDefs = [
    { name: 'Rahul Sharma',  email: 'rahul@email.com',   batchId: 'B2025-01', courses: [1,2] },   // Python + SQL
    { name: 'Sneha Patel',   email: 'sneha@email.com',   batchId: 'B2025-01', courses: [2,3] },   // SQL + BI
    { name: 'Arjun Kumar',   email: 'arjun@email.com',   batchId: 'B2025-06', courses: [1,4] },   // Python + ML
    { name: 'Meera Nair',    email: 'meera@email.com',   batchId: 'B2025-06', courses: [3,5] },   // BI + Excel
    { name: 'Kiran Reddy',   email: 'kiran@email.com',   batchId: 'B2025-07', courses: [1,2,3] }, // Python + SQL + BI
    { name: 'Ananya Singh',  email: 'ananya@email.com',  batchId: 'B2025-07', courses: [4,5] },   // ML + Excel
    { name: 'Rohan Verma',   email: 'rohan@email.com',   batchId: 'B2025-07', courses: [1,5] },   // Python + Excel
  ];

  DB.students = [];
  DB.enrollments = [];
  DB.progress = [];

  studentDefs.forEach((s, i) => {
    const uid = uuidv4();
    DB.users.push({ id: uid, email: s.email, password: bcrypt.hashSync('student123', 10), role: 'student', name: s.name, createdAt: new Date().toISOString() });
    const sid = i + 1;
    // Genuine start: students earn XP/streak/progress by actually completing modules & quizzes.
    DB.students.push({ id: sid, userId: uid, name: s.name, email: s.email, batchId: s.batchId, xp: 0, streak: 0, badges: 0, phone: '', joined: new Date().toISOString() });
    s.courses.forEach(cid => {
      DB.enrollments.push({ id: uuidv4(), studentId: sid, courseId: cid, enrolledAt: new Date().toISOString() });
      DB.progress.push({ id: uuidv4(), studentId: sid, courseId: cid, percent: 0, completedLessons: [], lastActivity: new Date().toISOString() });
    });
  });

  // ── Quizzes ──
  DB.quizzes = [
    { id: 1, courseId: 1, title: 'Python Basics Quiz', createdAt: new Date().toISOString(), questions: [
      { id:1, q:"What does print(type(3.14)) output?", opts:["<class 'int'>","<class 'float'>","<class 'str'>","<class 'double'>"], ans:1 },
      { id:2, q:"Which operator is used for floor division?", opts:["/","%","//","**"], ans:2 },
      { id:3, q:"What does df.shape return?", opts:["Number of columns","Column names","(rows, columns)","Total cells"], ans:2 },
    ]},
    { id: 2, courseId: 2, title: 'SQL Fundamentals Quiz', createdAt: new Date().toISOString(), questions: [
      { id:1, q:"Which clause filters rows after grouping?", opts:["WHERE","HAVING","FILTER","GROUP BY"], ans:1 },
      { id:2, q:"What does SELECT DISTINCT do?", opts:["Selects all rows","Removes duplicates","Selects NULLs","Counts unique"], ans:1 },
    ]},
  ];

  DB.notifications = [
    { id: uuidv4(), userId: null, title: 'Welcome to DhishaAI LMS!', body: 'Your multi-subject learning platform is ready.', read: false, createdAt: new Date().toISOString() },
  ];

  DB.assignments = [];
  DB.materials = [];
  DB.topics = [];
  DB.forum_posts = [];
  DB.quiz_results = [];

  // ── Authority (read-only batch monitor) ──
  const authUid = uuidv4();
  DB.users.push({ id: authUid, email: 'authority@dhishaai.com', password: bcrypt.hashSync('authority123', 10), role: 'authority', name: 'Batch Authority', createdAt: new Date().toISOString() });
  DB.authorities = [
    { id: 'AUTH-001', userId: authUid, name: 'Batch Authority', email: 'authority@dhishaai.com', batchIds: ['B2025-01'], phone: '', createdAt: new Date().toISOString() },
  ];

  saveDB();
  console.log('✅ Database seeded with multi-admin structure.');
  console.log('   SuperAdmin: superadmin@dhishaai.com / superadmin123');
  console.log('   Python Admin: priya@dhishaai.com / python123');
  console.log('   SQL Admin:    ravi@dhishaai.com   / sql123');
  console.log('   BI Admin:     divya@dhishaai.com  / powerbi123');
  console.log('   ML Admin:     anil@dhishaai.com   / ml123');
  console.log('   Excel Admin:  suma@dhishaai.com   / excel123');
  console.log('   Students: rahul@email.com / student123 (etc.)');
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Get the admin record for a logged-in admin user */
function getAdminRecord(userId) {
  return DB.admins.find(a => a.userId === userId);
}

/** Get the authority record for a logged-in authority user */
function getAuthorityRecord(userId) {
  return DB.authorities.find(a => a.userId === userId);
}

// Total number of syllabus topics for a course (from admin-authored modules).
// Returns 0 when the course has no modules (topic list is defined client-side).
function courseTotalTopics(course) {
  if (course && Array.isArray(course.modules) && course.modules.length) {
    return course.modules.reduce((a, m) => a + ((m.topics && m.topics.length) || 0), 0);
  }
  return 0;
}
// Live completion %: actually-completed topics / total topics — never a stale/stored
// number. Falls back to the stored percent only when the topic count isn't known here.
function livePercent(course, prog) {
  const total = courseTotalTopics(course);
  if (!total) return (prog && prog.percent) || 0;
  const done = Math.min(((prog && prog.completedLessons) || []).length, total);
  return Math.round((done / total) * 100);
}

/** Build a rich, read-only report object for a student (used by authority views) */
function studentReport(s) {
  const enrolled = DB.enrollments.filter(e => e.studentId === s.id).map(e => e.courseId);
  const courses = enrolled.map(cid => {
    const c = DB.courses.find(x => x.id === cid);
    const prog = DB.progress.find(p => p.studentId === s.id && p.courseId === cid);
    return { id: cid, title: c?.title || 'Course', category: c?.category || '', percent: livePercent(c, prog) };
  });
  const avgProgress = courses.length ? Math.round(courses.reduce((a, c) => a + c.percent, 0) / courses.length) : 0;
  const results = DB.quiz_results.filter(r => r.studentId === s.id).map(r => {
    const quiz = DB.quizzes.find(q => q.id === r.quizId);
    return { quizTitle: quiz?.title || 'Quiz', score: r.score, total: r.total, pct: r.total ? Math.round(r.score / r.total * 100) : 0, completedAt: r.completedAt };
  });
  const quizAvg = results.length ? Math.round(results.reduce((a, r) => a + r.pct, 0) / results.length) : 0;
  const batch = DB.batches.find(b => b.id === s.batchId);
  const lastActivity = DB.progress.filter(p => p.studentId === s.id).map(p => p.lastActivity).filter(Boolean).sort().reverse()[0] || null;
  return {
    id: s.id, name: s.name, email: s.email, phone: s.phone || '',
    batchId: s.batchId, batchName: batch?.name || s.batchId || '—',
    xp: s.xp || 0, streak: s.streak || 0, badges: s.badges || 0,
    courses, avgProgress, quizResults: results, quizAvg,
    completedCourses: courses.filter(c => c.percent >= 80).length,
    active: (s.streak > 0) || courses.some(c => c.percent > 0),
    lastActivity,
  };
}

/** Get course IDs owned by this admin */
function adminCourseIds(adminId) {
  return DB.courses.filter(c => c.ownerId === adminId).map(c => c.id);
}

/** Get student IDs enrolled in any of these courses */
function studentsInCourses(courseIds) {
  const ids = new Set(DB.enrollments.filter(e => courseIds.includes(e.courseId)).map(e => e.studentId));
  return [...ids];
}

/** Is the quiz enabled for a specific batch on this course?
 *  A per-batch override (course.quizBatch[batchId]) wins; otherwise falls back to the
 *  course-wide quizEnabled flag. Lets different admins/batches control quizzes independently. */
function quizOnForBatch(course, batchId) {
  if (!course) return false;
  if (course.quizBatch && batchId && Object.prototype.hasOwnProperty.call(course.quizBatch, batchId)) {
    return !!course.quizBatch[batchId];
  }
  return !!course.quizEnabled;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(h.split(' ')[1], JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminOrSuper(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function superOnly(req, res, next) {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Super admin only' });
  next();
}

function authorityOnly(req, res, next) {
  if (req.user?.role !== 'authority') return res.status(403).json({ error: 'Authority access required' });
  next();
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '3.0.0', time: new Date().toISOString() }));

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = DB.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  
  const payload = { id: user.id, email: user.email, role: user.role, name: user.name };
  
  // For admin: attach their admin record id
  if (user.role === 'admin') {
    const adminRec = getAdminRecord(user.id);
    if (adminRec) payload.adminId = adminRec.id;
  }
  // For authority: attach their authority record id + assigned batches
  if (user.role === 'authority') {
    const authRec = getAuthorityRecord(user.id);
    if (authRec) { payload.authorityId = authRec.id; payload.batchIds = authRec.batchIds || []; }
  }

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  const student = user.role === 'student' ? DB.students.find(s => s.userId === user.id) : null;
  const adminRec = (user.role === 'admin') ? getAdminRecord(user.id) : null;
  const authRec  = (user.role === 'authority') ? getAuthorityRecord(user.id) : null;

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    studentId: student?.id || null,
    adminId:   adminRec?.id || null,
    subject:   adminRec?.subject || null,
    subjects:  adminRec?.subjects || (adminRec?.subject ? [adminRec.subject] : []),
    authorityId: authRec?.id || null,
    batchIds:    authRec?.batchIds || [],
  });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = DB.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const student  = user.role === 'student' ? DB.students.find(s => s.userId === user.id) : null;
  const adminRec = user.role === 'admin'   ? getAdminRecord(user.id) : null;
  const authRec  = user.role === 'authority' ? getAuthorityRecord(user.id) : null;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, studentId: student?.id || null, adminId: adminRec?.id || null, subject: adminRec?.subject || null, subjects: adminRec?.subjects || (adminRec?.subject ? [adminRec.subject] : []), authorityId: authRec?.id || null, batchIds: authRec?.batchIds || [] });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (DB.users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already registered' });
  const uid = uuidv4();
  DB.users.push({ id: uid, email, password: bcrypt.hashSync(password, 10), role: 'student', name, createdAt: new Date().toISOString() });
  const sid = (DB.students.length > 0 ? Math.max(...DB.students.map(s=>s.id)) : 0) + 1;
  DB.students.push({ id: sid, userId: uid, name, email, batchId: '', xp: 0, streak: 0, badges: 0, phone: '', joined: new Date().toISOString() });
  saveDB();
  const token = jwt.sign({ id: uid, email, role: 'student', name }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: { id: uid, name, email, role: 'student' }, studentId: sid });
});

// ── SUPER ADMIN — manage course admins ────────────────────────────────────────
app.get('/api/super/admins', auth, superOnly, (req, res) => {
  const result = DB.admins.map(a => ({
    ...a,
    courses: DB.courses.filter(c => c.ownerId === a.id).map(c => ({ id: c.id, title: c.title, category: c.category })),
    studentCount: studentsInCourses(adminCourseIds(a.id)).length,
  }));
  res.json(result);
});

app.post('/api/super/admins', auth, superOnly, (req, res) => {
  const { name, email, password, subject, subjects, phone, courseIds } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
  if (DB.users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already exists' });
  // Accept either a subjects array (new) or a single subject string (legacy)
  const subjList = Array.isArray(subjects) ? subjects.filter(Boolean) : (subject ? [subject] : []);
  const uid = uuidv4();
  const aid = `ADM-${String(DB.admins.length + 1).padStart(3,'0')}`;
  DB.users.push({ id: uid, email, password: bcrypt.hashSync(password, 10), role: 'admin', name, createdAt: new Date().toISOString() });
  DB.admins.push({ id: aid, userId: uid, name, email, subjects: subjList, subject: subjList[0] || '', phone: phone || '', createdAt: new Date().toISOString() });
  // Assign selected courses to this new admin
  if (Array.isArray(courseIds)) {
    const ids = courseIds.map(Number);
    DB.courses.forEach(c => { if (ids.includes(c.id)) c.ownerId = aid; });
  }
  saveDB();
  res.status(201).json({ id: aid, name, email, subjects: subjList, subject: subjList[0] || '' });
});

app.put('/api/super/admins/:id', auth, superOnly, (req, res) => {
  const idx = DB.admins.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const { name, subject, subjects, phone, courseIds } = req.body;
  const subjList = Array.isArray(subjects) ? subjects.filter(Boolean)
    : (subject !== undefined ? (subject ? [subject] : []) : (DB.admins[idx].subjects || (DB.admins[idx].subject ? [DB.admins[idx].subject] : [])));
  DB.admins[idx] = { ...DB.admins[idx], name: name||DB.admins[idx].name, subjects: subjList, subject: subjList[0] || '', phone: phone||DB.admins[idx].phone };
  // Reassign course ownership to match the selected list
  if (Array.isArray(courseIds)) {
    const aid = DB.admins[idx].id;
    const ids = courseIds.map(Number);
    DB.courses.forEach(c => {
      if (ids.includes(c.id)) c.ownerId = aid;              // assign selected
      else if (c.ownerId === aid) c.ownerId = null;         // release ones no longer selected
    });
  }
  const uidx = DB.users.findIndex(u => u.id === DB.admins[idx].userId);
  if (uidx >= 0 && name) DB.users[uidx].name = name;
  saveDB();
  res.json(DB.admins[idx]);
});

app.delete('/api/super/admins/:id', auth, superOnly, (req, res) => {
  const admin = DB.admins.find(a => a.id === req.params.id);
  if (!admin) return res.status(404).json({ error: 'Not found' });
  DB.users   = DB.users.filter(u => u.id !== admin.userId);
  DB.admins  = DB.admins.filter(a => a.id !== req.params.id);
  // Courses become unowned (don't delete — students lose access otherwise)
  DB.courses.forEach(c => { if (c.ownerId === req.params.id) c.ownerId = null; });
  saveDB();
  res.json({ success: true });
});

// ── SUPER ADMIN — manage authorities (read-only batch monitors) ────────────────
app.get('/api/super/authorities', auth, superOnly, (req, res) => {
  res.json(DB.authorities.map(a => ({
    ...a,
    batches: (a.batchIds || []).map(bid => DB.batches.find(b => b.id === bid)).filter(Boolean).map(b => ({ id: b.id, name: b.name })),
    studentCount: DB.students.filter(s => (a.batchIds || []).includes(s.batchId)).length,
  })));
});

app.post('/api/super/authorities', auth, superOnly, (req, res) => {
  const { name, email, password, batchIds, phone } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
  if (DB.users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already exists' });
  const uid = uuidv4();
  const aid = `AUTH-${String(DB.authorities.length + 1).padStart(3, '0')}`;
  DB.users.push({ id: uid, email, password: bcrypt.hashSync(password, 10), role: 'authority', name, createdAt: new Date().toISOString() });
  DB.authorities.push({ id: aid, userId: uid, name, email, batchIds: Array.isArray(batchIds) ? batchIds : [], phone: phone || '', createdAt: new Date().toISOString() });
  saveDB();
  res.status(201).json({ id: aid, name, email, batchIds: Array.isArray(batchIds) ? batchIds : [] });
});

app.put('/api/super/authorities/:id', auth, superOnly, (req, res) => {
  const idx = DB.authorities.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const { name, batchIds, phone } = req.body;
  DB.authorities[idx] = {
    ...DB.authorities[idx],
    name: name || DB.authorities[idx].name,
    batchIds: Array.isArray(batchIds) ? batchIds : DB.authorities[idx].batchIds,
    phone: phone !== undefined ? phone : DB.authorities[idx].phone,
  };
  const uidx = DB.users.findIndex(u => u.id === DB.authorities[idx].userId);
  if (uidx >= 0 && name) DB.users[uidx].name = name;
  saveDB();
  res.json(DB.authorities[idx]);
});

app.delete('/api/super/authorities/:id', auth, superOnly, (req, res) => {
  const a = DB.authorities.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  DB.users       = DB.users.filter(u => u.id !== a.userId);
  DB.authorities = DB.authorities.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ success: true });
});

// ── AUTHORITY — read-only report of their assigned batches ─────────────────────
app.get('/api/authority/data', auth, authorityOnly, (req, res) => {
  const authRec = getAuthorityRecord(req.user.id);
  if (!authRec) return res.status(404).json({ error: 'Authority record not found' });
  const batchIds = authRec.batchIds || [];
  const batchStudents = DB.students.filter(s => batchIds.includes(s.batchId));
  const students = batchStudents.map(studentReport);
  const active = students.filter(s => s.active).length;
  const avgProgress = students.length ? Math.round(students.reduce((a, s) => a + s.avgProgress, 0) / students.length) : 0;
  const avgQuiz = (() => {
    const withQuiz = students.filter(s => s.quizResults.length > 0);
    return withQuiz.length ? Math.round(withQuiz.reduce((a, s) => a + s.quizAvg, 0) / withQuiz.length) : 0;
  })();
  const batches = batchIds.map(bid => {
    const b = DB.batches.find(x => x.id === bid);
    const bs = students.filter(s => s.batchId === bid);
    return {
      id: bid, name: b?.name || bid,
      total: bs.length,
      active: bs.filter(s => s.active).length,
      avgProgress: bs.length ? Math.round(bs.reduce((a, s) => a + s.avgProgress, 0) / bs.length) : 0,
    };
  });
  res.json({
    authority: { name: authRec.name, email: authRec.email },
    stats: { totalStudents: students.length, activeStudents: active, avgProgress, avgQuiz, batchCount: batchIds.length },
    batches,
    students,
  });
});

// Super admin analytics (all platform data)
app.get('/api/super/analytics', auth, superOnly, (req, res) => {
  res.json({
    totalStudents:  DB.students.length,
    totalAdmins:    DB.admins.length,
    totalCourses:   DB.courses.length,
    totalQuizzes:   DB.quizzes.length,
    totalAttempts:  DB.quiz_results.length,
    avgScore:       DB.quiz_results.length > 0 ? Math.round(DB.quiz_results.reduce((a,r)=>a+(r.score/r.total*100),0)/DB.quiz_results.length) : 0,
    adminBreakdown: DB.admins.map(a => ({
      name:         a.name,
      subject:      a.subject,
      courses:      DB.courses.filter(c=>c.ownerId===a.id).length,
      students:     studentsInCourses(adminCourseIds(a.id)).length,
    })),
    courseBreakdown: DB.courses.map(c => ({
      title:    c.title,
      enrolled: DB.enrollments.filter(e=>e.courseId===c.id).length,
      owner:    DB.admins.find(a=>a.id===c.ownerId)?.name || 'Unassigned',
    })),
    recentResults: DB.quiz_results.slice(-20).reverse(),
  });
});

// ── COURSES ───────────────────────────────────────────────────────────────────
app.get('/api/courses', auth, (req, res) => {
  const { role, id: userId } = req.user;

  // Super admin — all courses
  if (role === 'superadmin') return res.json(DB.courses);

  // Course admin — only their courses
  if (role === 'admin') {
    const adminRec = getAdminRecord(userId);
    if (!adminRec) return res.json([]);
    return res.json(DB.courses.filter(c => c.ownerId === adminRec.id));
  }

  // Student — all courses they're enrolled in (from any admin)
  const student = DB.students.find(s => s.userId === userId);
  if (!student) return res.json([]);
  const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
  const courses  = DB.courses.filter(c => enrolled.includes(c.id)).map(c => {
    const prog = DB.progress.find(p => p.studentId === student.id && p.courseId === c.id);
    const owner = DB.admins.find(a => a.id === c.ownerId);
    return { ...c, progress: livePercent(c, prog), instructorName: owner?.name || 'DhishaAI' };
  });
  res.json(courses);
});

app.post('/api/courses', auth, adminOrSuper, (req, res) => {
  const { title, category, lessons, duration, description, color } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  
  let ownerId = null;
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminRec) return res.status(403).json({ error: 'Admin record not found' });
    ownerId = adminRec.id;
  } else if (req.body.ownerId) {
    ownerId = req.body.ownerId; // superadmin can assign to any admin
  }

  const id = (DB.courses.length > 0 ? Math.max(...DB.courses.map(c=>c.id)) : 0) + 1;
  const course = { id, ownerId, title, category: category||'General', lessons: lessons||0, duration: duration||'', description: description||'', color: color||'#4F46E5', syllabusUnlocked: false, quizEnabled: false, modules: [], createdAt: new Date().toISOString() };
  DB.courses.push(course);
  saveDB();
  res.status(201).json(course);
});

app.put('/api/courses/:id', auth, adminOrSuper, (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = DB.courses.findIndex(c => c.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });

  // Admin can only edit their own courses
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (DB.courses[idx].ownerId !== adminRec?.id) return res.status(403).json({ error: 'Not your course' });
  }

  DB.courses[idx] = { ...DB.courses[idx], ...req.body, id };
  saveDB();
  res.json(DB.courses[idx]);
});

// Enable/disable quizzes for ONE batch on a course (per-batch control for the course's admin)
app.put('/api/courses/:id/quiz-batch', auth, adminOrSuper, (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = DB.courses.findIndex(c => c.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (DB.courses[idx].ownerId !== adminRec?.id) return res.status(403).json({ error: 'Not your course' });
  }
  const { batchId, enabled } = req.body;
  if (!batchId) return res.status(400).json({ error: 'batchId required' });
  if (!DB.courses[idx].quizBatch) DB.courses[idx].quizBatch = {};
  DB.courses[idx].quizBatch[batchId] = !!enabled;
  saveDB();
  res.json(DB.courses[idx]);
});

// ── COURSE MODULES (admin-authored: add/edit/delete one by one) ────────────────
function canEditCourse(req, course) {
  if (req.user.role === 'superadmin') return true;
  if (req.user.role === 'admin') return course.ownerId === getAdminRecord(req.user.id)?.id;
  return false;
}

app.post('/api/courses/:id/modules', auth, adminOrSuper, (req, res) => {
  const id = parseInt(req.params.id);
  const c = DB.courses.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!canEditCourse(req, c)) return res.status(403).json({ error: 'Not your course' });
  if (!Array.isArray(c.modules)) c.modules = [];
  const { title, topics } = req.body;
  c.modules.push({ title: title || `Module ${c.modules.length + 1}`, topics: Array.isArray(topics) ? topics.filter(t => t && t.trim()).map(t => t.trim()) : [] });
  saveDB();
  res.status(201).json(c);
});

app.put('/api/courses/:id/modules/:mi', auth, adminOrSuper, (req, res) => {
  const id = parseInt(req.params.id), mi = parseInt(req.params.mi);
  const c = DB.courses.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!canEditCourse(req, c)) return res.status(403).json({ error: 'Not your course' });
  const mods = c.modules || [];
  if (mi < 0 || mi >= mods.length) return res.status(404).json({ error: 'Module not found' });
  const { title, topics } = req.body;
  if (title !== undefined) mods[mi].title = title;
  if (Array.isArray(topics)) mods[mi].topics = topics.filter(t => t && t.trim()).map(t => t.trim());
  saveDB();
  res.json(c);
});

app.delete('/api/courses/:id/modules/:mi', auth, adminOrSuper, (req, res) => {
  const id = parseInt(req.params.id), mi = parseInt(req.params.mi);
  const c = DB.courses.find(x => x.id === id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!canEditCourse(req, c)) return res.status(403).json({ error: 'Not your course' });
  const mods = c.modules || [];
  if (mi < 0 || mi >= mods.length) return res.status(404).json({ error: 'Module not found' });
  mods.splice(mi, 1);
  // Keep attached notes/quizzes aligned with the shifted module indexes
  DB.materials.forEach(m => { if (Number(m.courseId) === id && m.moduleIndex != null) { if (m.moduleIndex === mi) m.moduleIndex = null; else if (m.moduleIndex > mi) m.moduleIndex -= 1; } });
  DB.quizzes.forEach(q => { if (q.courseId === id && q.moduleIndex != null) { if (q.moduleIndex === mi) q.moduleIndex = null; else if (q.moduleIndex > mi) q.moduleIndex -= 1; } });
  saveDB();
  res.json(c);
});

app.delete('/api/courses/:id', auth, adminOrSuper, (req, res) => {
  const id = parseInt(req.params.id);
  const course = DB.courses.find(c => c.id === id);
  if (!course) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (course.ownerId !== adminRec?.id) return res.status(403).json({ error: 'Not your course' });
  }

  DB.courses     = DB.courses.filter(c => c.id !== id);
  DB.enrollments = DB.enrollments.filter(e => e.courseId !== id);
  DB.progress    = DB.progress.filter(p => p.courseId !== id);
  DB.quizzes     = DB.quizzes.filter(q => q.courseId !== id);
  saveDB();
  res.json({ success: true });
});

// ── STUDENTS ──────────────────────────────────────────────────────────────────
app.get('/api/students', auth, adminOrSuper, (req, res) => {
  const { role, id: userId } = req.user;
  
  let visibleStudentIds;
  if (role === 'superadmin') {
    visibleStudentIds = DB.students.map(s => s.id); // all
  } else {
    const adminRec = getAdminRecord(userId);
    if (!adminRec) return res.json([]);
    const myCourseIds = adminCourseIds(adminRec.id);
    visibleStudentIds = studentsInCourses(myCourseIds);
  }

  const result = DB.students
    .filter(s => visibleStudentIds.includes(s.id))
    .map(s => ({
      ...s,
      enrolledCourses: DB.enrollments.filter(e => e.studentId === s.id).map(e => e.courseId),
      progress: DB.progress.filter(p => p.studentId === s.id),
    }));

  res.json(result);
});

app.post('/api/students', auth, adminOrSuper, (req, res) => {
  const { name, email, password, batchId, phone, enrolledCourses } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (DB.users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already exists' });

  // Admin can only enroll students into THEIR courses
  let allowedCourses = enrolledCourses || [];
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myCourseIds = adminCourseIds(adminRec.id);
    allowedCourses = allowedCourses.filter(cid => myCourseIds.includes(cid));
  }

  const uid = uuidv4();
  DB.users.push({ id: uid, email, password: bcrypt.hashSync(password || 'student123', 10), role: 'student', name, createdAt: new Date().toISOString() });
  const sid = (DB.students.length > 0 ? Math.max(...DB.students.map(s=>s.id)) : 0) + 1;
  DB.students.push({ id: sid, userId: uid, name, email, batchId: batchId||'', xp: 0, streak: 0, badges: 0, phone: phone||'', joined: new Date().toISOString() });

  allowedCourses.forEach(cid => {
    if (!DB.enrollments.find(e => e.studentId === sid && e.courseId === cid)) {
      DB.enrollments.push({ id: uuidv4(), studentId: sid, courseId: cid, enrolledAt: new Date().toISOString() });
      DB.progress.push({ id: uuidv4(), studentId: sid, courseId: cid, percent: 0, lastActivity: new Date().toISOString() });
    }
  });

  saveDB();
  res.status(201).json({ ...DB.students.find(s=>s.id===sid), enrolledCourses: allowedCourses });
});

app.put('/api/students/:id', auth, adminOrSuper, (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = DB.students.findIndex(s => s.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });

  // Admin can only update students in their courses
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myCourseIds = adminCourseIds(adminRec.id);
    const myStudentIds = studentsInCourses(myCourseIds);
    if (!myStudentIds.includes(id)) return res.status(403).json({ error: 'Not your student' });
  }

  const { name, batchId, phone, enrolledCourses } = req.body;
  DB.students[idx] = { ...DB.students[idx], name: name||DB.students[idx].name, batchId: batchId||DB.students[idx].batchId, phone: phone||DB.students[idx].phone };

  if (enrolledCourses !== undefined) {
    // Admin can only add/remove from their own courses — preserve other courses
    if (req.user.role === 'admin') {
      const adminRec  = getAdminRecord(req.user.id);
      const myCourseIds = adminCourseIds(adminRec.id);
      // Remove existing enrollments for this admin's courses only
      DB.enrollments = DB.enrollments.filter(e => !(e.studentId === id && myCourseIds.includes(e.courseId)));
      DB.progress    = DB.progress.filter(p    => !(p.studentId === id && myCourseIds.includes(p.courseId)));
      // Add new ones
      enrolledCourses.filter(cid => myCourseIds.includes(cid)).forEach(cid => {
        DB.enrollments.push({ id: uuidv4(), studentId: id, courseId: cid, enrolledAt: new Date().toISOString() });
        DB.progress.push({ id: uuidv4(), studentId: id, courseId: cid, percent: 0, lastActivity: new Date().toISOString() });
      });
    } else {
      // Super admin can change all
      DB.enrollments = DB.enrollments.filter(e => e.studentId !== id);
      DB.progress    = DB.progress.filter(p => p.studentId !== id);
      enrolledCourses.forEach(cid => {
        DB.enrollments.push({ id: uuidv4(), studentId: id, courseId: cid, enrolledAt: new Date().toISOString() });
        DB.progress.push({ id: uuidv4(), studentId: id, courseId: cid, percent: 0, lastActivity: new Date().toISOString() });
      });
    }
  }

  const uidx = DB.users.findIndex(u => u.id === DB.students[idx].userId);
  if (uidx >= 0 && name) DB.users[uidx].name = name;
  saveDB();
  res.json({ ...DB.students[idx], enrolledCourses: DB.enrollments.filter(e=>e.studentId===id).map(e=>e.courseId) });
});

app.delete('/api/students/:id', auth, adminOrSuper, (req, res) => {
  const id = parseInt(req.params.id);
  const s  = DB.students.find(s => s.id === id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myStudentIds = studentsInCourses(adminCourseIds(adminRec.id));
    if (!myStudentIds.includes(id)) return res.status(403).json({ error: 'Not your student' });
  }

  DB.users        = DB.users.filter(u => u.id !== s.userId);
  DB.students     = DB.students.filter(s => s.id !== id);
  DB.enrollments  = DB.enrollments.filter(e => e.studentId !== id);
  DB.progress     = DB.progress.filter(p => p.studentId !== id);
  DB.quiz_results = DB.quiz_results.filter(q => q.studentId !== id);
  saveDB();
  res.json({ success: true });
});

// ── QUIZZES ───────────────────────────────────────────────────────────────────
app.get('/api/quizzes', auth, (req, res) => {
  if (req.user.role === 'superadmin') return res.json(DB.quizzes);

  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myCourseIds = adminCourseIds(adminRec?.id);
    return res.json(DB.quizzes.filter(q => myCourseIds.includes(q.courseId)));
  }

  const student  = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.json([]);
  const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
  res.json(DB.quizzes.filter(q => {
    const course = DB.courses.find(c => c.id === q.courseId);
    return enrolled.includes(q.courseId) && quizOnForBatch(course, student.batchId);
  }));
});

app.post('/api/quizzes', auth, adminOrSuper, (req, res) => {
  const { courseId, title, questions, moduleIndex, timeLimit } = req.body;
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(courseId)) return res.status(403).json({ error: 'Not your course' });
  }
  const id = (DB.quizzes.length > 0 ? Math.max(...DB.quizzes.map(q=>q.id)) : 0) + 1;
  const tl = (timeLimit === undefined || timeLimit === null || timeLimit === '') ? null : Number(timeLimit);
  const quiz = { id, courseId, title: title||'New Quiz', questions: questions||[], moduleIndex: (moduleIndex === undefined ? null : moduleIndex), timeLimit: (tl && tl > 0) ? tl : null, createdAt: new Date().toISOString() };
  DB.quizzes.push(quiz);
  saveDB();
  res.status(201).json(quiz);
});

app.put('/api/quizzes/:id', auth, adminOrSuper, (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = DB.quizzes.findIndex(q => q.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(DB.quizzes[idx].courseId)) return res.status(403).json({ error: 'Not your quiz' });
  }
  DB.quizzes[idx] = { ...DB.quizzes[idx], ...req.body, id };
  // Normalize the time limit (blank/0 => no limit)
  const tl = Number(DB.quizzes[idx].timeLimit);
  DB.quizzes[idx].timeLimit = (tl && tl > 0) ? tl : null;
  saveDB();
  res.json(DB.quizzes[idx]);
});

app.delete('/api/quizzes/:id', auth, adminOrSuper, (req, res) => {
  const id = parseInt(req.params.id);
  const quiz = DB.quizzes.find(q => q.id === id);
  if (!quiz) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(quiz.courseId)) return res.status(403).json({ error: 'Not your quiz' });
  }
  DB.quizzes = DB.quizzes.filter(q => q.id !== id);
  saveDB();
  res.json({ success: true });
});

// ── QUIZ RESULTS ──────────────────────────────────────────────────────────────
app.post('/api/quiz-results', auth, (req, res) => {
  const { quizId, courseId, score, total, answers } = req.body;
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(400).json({ error: 'Student not found' });
  const result = { id: uuidv4(), studentId: student.id, quizId, courseId, score, total, answers, completedAt: new Date().toISOString() };
  DB.quiz_results.push(result);
  const xpGain = Math.round((score/total)*100);
  const sidx = DB.students.findIndex(s => s.id === student.id);
  if (sidx >= 0) DB.students[sidx].xp += xpGain;
  saveDB();
  res.status(201).json({ ...result, xpGained: xpGain });
});

app.get('/api/quiz-results', auth, (req, res) => {
  if (req.user.role === 'superadmin') return res.json(DB.quiz_results);
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myCourseIds = adminCourseIds(adminRec?.id);
    return res.json(DB.quiz_results.filter(r => myCourseIds.includes(r.courseId)));
  }
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.json([]);
  res.json(DB.quiz_results.filter(r => r.studentId === student.id));
});

// ── PROGRESS ──────────────────────────────────────────────────────────────────
app.get('/api/progress/:studentId', auth, (req, res) => {
  res.json(DB.progress.filter(p => p.studentId === parseInt(req.params.studentId)));
});

app.put('/api/progress', auth, (req, res) => {
  const { courseId, percent, completedLessons } = req.body;
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(400).json({ error: 'Student not found' });
  const idx = DB.progress.findIndex(p => p.studentId === student.id && p.courseId === courseId);
  if (idx >= 0) {
    DB.progress[idx].percent = percent;
    if (completedLessons !== undefined) DB.progress[idx].completedLessons = completedLessons;
    DB.progress[idx].lastActivity = new Date().toISOString();
  } else {
    DB.progress.push({ id: uuidv4(), studentId: student.id, courseId, percent, completedLessons: completedLessons || [], lastActivity: new Date().toISOString() });
  }
  const sidx = DB.students.findIndex(s => s.id === student.id);
  if (sidx >= 0) DB.students[sidx].xp += 10;
  saveDB();
  res.json({ success: true });
});

// ── ANALYTICS (admin scoped) ──────────────────────────────────────────────────
app.get('/api/analytics/overview', auth, adminOrSuper, (req, res) => {
  if (req.user.role === 'superadmin') {
    // Redirect to super analytics
    return res.json({
      totalStudents: DB.students.length,
      totalCourses:  DB.courses.length,
      totalQuizzes:  DB.quizzes.length,
      totalAttempts: DB.quiz_results.length,
      avgScore:      DB.quiz_results.length > 0 ? Math.round(DB.quiz_results.reduce((a,r)=>a+(r.score/r.total*100),0)/DB.quiz_results.length) : 0,
      activeStudents: DB.students.filter(s=>s.streak>0).length,
      progressByStudent: DB.students.map(s=>({ name:s.name, xp:s.xp, progress: DB.progress.filter(p=>p.studentId===s.id).reduce((a,p)=>a+p.percent,0)/Math.max(1,DB.enrollments.filter(e=>e.studentId===s.id).length) })),
      quizResults: DB.quiz_results,
      enrollmentsByBatch: DB.batches.map(b=>({ batch:b.name, count:DB.students.filter(s=>s.batchId===b.id).length })),
    });
  }

  const adminRec     = getAdminRecord(req.user.id);
  const myCourseIds  = adminCourseIds(adminRec?.id);
  const myStudentIds = studentsInCourses(myCourseIds);
  const myStudents   = DB.students.filter(s => myStudentIds.includes(s.id));
  const myResults    = DB.quiz_results.filter(r => myCourseIds.includes(r.courseId));

  res.json({
    totalStudents:  myStudents.length,
    totalCourses:   myCourseIds.length,
    totalQuizzes:   DB.quizzes.filter(q => myCourseIds.includes(q.courseId)).length,
    totalAttempts:  myResults.length,
    avgScore:       myResults.length > 0 ? Math.round(myResults.reduce((a,r)=>a+(r.score/r.total*100),0)/myResults.length) : 0,
    activeStudents: myStudents.filter(s=>s.streak>0).length,
    progressByStudent: myStudents.map(s=>({ name:s.name, xp:s.xp, progress: DB.progress.filter(p=>p.studentId===s.id && myCourseIds.includes(p.courseId)).reduce((a,p)=>a+p.percent,0)/Math.max(1,myCourseIds.length) })),
    quizResults: myResults,
    enrollmentsByBatch: DB.batches.map(b=>({ batch:b.name, count:myStudents.filter(s=>s.batchId===b.id).length })),
  });
});

// ── BATCHES ───────────────────────────────────────────────────────────────────
app.get('/api/batches', auth, (req, res) => res.json(DB.batches));

app.post('/api/batches', auth, adminOrSuper, (req, res) => {
  const { name, startDate } = req.body;
  const id = `B${new Date().getFullYear()}-${String(DB.batches.length+1).padStart(2,'0')}`;
  const batch = { id, name: name||id, startDate: startDate||'' };
  DB.batches.push(batch);
  saveDB();
  res.status(201).json(batch);
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
app.get('/api/notifications', auth, (req, res) => {
  res.json(DB.notifications.filter(n => !n.userId || n.userId === req.user.id));
});

app.put('/api/notifications/:id/read', auth, (req, res) => {
  const idx = DB.notifications.findIndex(n => n.id === req.params.id);
  if (idx >= 0) DB.notifications[idx].read = true;
  saveDB();
  res.json({ success: true });
});

app.post('/api/notifications', auth, adminOrSuper, (req, res) => {
  // Admin can only notify their own students
  const { title, body, toAll } = req.body;
  const n = { id: uuidv4(), userId: null, title, body, read: false, createdAt: new Date().toISOString() };
  DB.notifications.push(n);
  saveDB();
  res.status(201).json(n);
});

// ── QUIZ ANTI-CHEAT: a student left the quiz tab/window ───────────────────────
// Records the violation and alerts the course's admin + all super admins.
app.post('/api/quiz-violation', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(404).json({ error: 'Not found' });
  const { quizId, courseId, reason } = req.body;
  const course = DB.courses.find(c => c.id === Number(courseId));
  const quiz   = DB.quizzes.find(q => q.id === quizId);
  const when   = new Date().toISOString();
  const body = `⚠️ ${student.name} (${student.email}) was locked out of the quiz "${quiz?.title || 'Quiz'}"${course ? ` in ${course.title}` : ''} for leaving the quiz tab (${reason || 'tab switch'}). Possible cheating attempt.`;

  // Target the course-owner admin (by user id) + every super admin.
  const targets = new Set();
  if (course && course.ownerId) {
    const owner = DB.admins.find(a => a.id === course.ownerId);
    if (owner && owner.userId) targets.add(owner.userId);
  }
  DB.users.filter(u => u.role === 'superadmin').forEach(u => targets.add(u.id));
  targets.forEach(uid => {
    DB.notifications.push({ id: uuidv4(), userId: uid, title: 'Quiz lock — possible cheating', body, type: 'violation', read: false, createdAt: when });
  });

  // Audit trail on the student record.
  if (!Array.isArray(student.violations)) student.violations = [];
  student.violations.push({ quizId: quizId || null, courseId: course?.id || null, reason: reason || 'tab-switch', at: when });

  saveDB();
  res.json({ success: true, notified: targets.size });
});

// ── AI (Claude) — tutor chat + playground code runner ─────────────────────────
// The API key stays server-side (in ai.js); the browser only talks to these.
app.get('/api/ai/status', auth, (req, res) => res.json({ available: ai.aiAvailable() }));

app.post('/api/ai/tutor', auth, async (req, res) => {
  try { res.json(await ai.tutor(req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'AI error' }); }
});

app.post('/api/ai/run', auth, async (req, res) => {
  try { res.json(await ai.runCode(req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'AI error' }); }
});

app.post('/api/ai/career', auth, async (req, res) => {
  try { res.json(await ai.careerAdvice(req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'AI error' }); }
});

// ── PROFILE ───────────────────────────────────────────────────────────────────
app.get('/api/profile', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(404).json({ error: 'Not found' });
  const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
  // Live completion: recompute each course's percent from actually-completed topics.
  const progress = DB.progress.filter(p => p.studentId === student.id)
    .map(p => ({ ...p, percent: livePercent(DB.courses.find(c => c.id === p.courseId), p) }));
  const results  = DB.quiz_results.filter(r => r.studentId === student.id);
  const batch    = DB.batches.find(b => b.id === student.batchId);
  res.json({ ...student, batchName: batch?.name || student.batchId || null, enrolledCourses: enrolled, progress, quizResults: results });
});

app.put('/api/profile', auth, (req, res) => {
  const sidx = DB.students.findIndex(s => s.userId === req.user.id);
  if (sidx < 0) return res.status(404).json({ error: 'Not found' });
  const { name, phone } = req.body;
  if (name) DB.students[sidx].name = name;
  if (phone) DB.students[sidx].phone = phone;
  const uidx = DB.users.findIndex(u => u.id === req.user.id);
  if (uidx >= 0 && name) DB.users[uidx].name = name;
  saveDB();
  res.json(DB.students[sidx]);
});

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
app.get('/api/leaderboard', auth, (req, res) => {
  // Admin: only their students on leaderboard
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myStudentIds = studentsInCourses(adminCourseIds(adminRec?.id));
    const board = DB.students.filter(s => myStudentIds.includes(s.id))
      .map(s => ({ id: s.id, name: s.name, xp: s.xp, streak: s.streak, badges: s.badges }))
      .sort((a,b) => b.xp - a.xp);
    return res.json(board);
  }
  // Student / super: all students
  const board = DB.students.map(s => ({ id: s.id, name: s.name, xp: s.xp, streak: s.streak, badges: s.badges })).sort((a,b) => b.xp - a.xp);
  res.json(board);
});

// ── ASSIGNMENTS ───────────────────────────────────────────────────────────────
app.get('/api/assignments', auth, (req, res) => {
  if (req.user.role === 'superadmin') return res.json(DB.assignments);
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myCourseIds = adminCourseIds(adminRec?.id);
    return res.json(DB.assignments.filter(a => myCourseIds.includes(a.courseId)));
  }
  const student  = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.json([]);
  const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
  // also include batch-targeted assignments
  const batchAssignments = DB.assignments.filter(a => a.batchId && a.batchId === student.batchId);
  const courseAssignments = DB.assignments.filter(a => a.courseId && enrolled.includes(a.courseId));
  const all = [...new Map([...batchAssignments, ...courseAssignments].map(a => [a.id, a])).values()];
  res.json(all);
});

app.post('/api/assignments', auth, adminOrSuper, (req, res) => {
  const { courseId, batchId, title, description, dueDate } = req.body;
  if (req.user.role === 'admin' && courseId) {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(Number(courseId))) return res.status(403).json({ error: 'Not your course' });
  }
  const adminRec = req.user.role !== 'superadmin' ? getAdminRecord(req.user.id) : null;
  const a = { id: uuidv4(), courseId: courseId || null, batchId: batchId || null, adminId: adminRec?.id || null, adminName: req.user.name, title, description, dueDate: dueDate || null, createdAt: new Date().toISOString() };
  DB.assignments.push(a);
  saveDB();
  res.status(201).json(a);
});

app.delete('/api/assignments/:id', auth, adminOrSuper, (req, res) => {
  const a = DB.assignments.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (a.adminId !== adminRec?.id) return res.status(403).json({ error: 'Not your assignment' });
  }
  DB.assignments = DB.assignments.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ success: true });
});

// ── MATERIALS (Notes / PDFs / Files) ─────────────────────────────────────────
// Materials are stored as base64 in JSON (suitable for small-medium files <5MB)
// Structure: { id, type:'note'|'file', courseId, batchId, adminId, adminName,
//              title, description, fileData(base64), fileName, fileType,
//              fileSize, createdAt, pinned }

if (!DB.materials) DB.materials = [];

app.get('/api/materials', auth, (req, res) => {
  if (!DB.materials) DB.materials = [];
  if (req.user.role === 'superadmin') return res.json(DB.materials.map(m => ({ ...m, fileData: undefined })));
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myCourseIds = adminCourseIds(adminRec?.id);
    const mine = DB.materials.filter(m =>
      (m.courseId && myCourseIds.includes(Number(m.courseId))) ||
      m.adminId === adminRec?.id
    );
    return res.json(mine.map(m => ({ ...m, fileData: undefined })));
  }
  // Student — filter by enrolled courses + batch
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.json([]);
  const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
  const result = DB.materials.filter(m =>
    (m.courseId && enrolled.includes(Number(m.courseId))) ||
    (m.batchId && m.batchId === student.batchId)
  );
  res.json(result.map(m => ({ ...m, fileData: undefined })));
});

app.post('/api/materials', auth, adminOrSuper, (req, res) => {
  if (!DB.materials) DB.materials = [];
  const { courseId, batchId, title, description, type, fileData, fileName, fileType, fileSize, pinned, moduleIndex } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  // size guard — ~5MB base64
  if (fileData && fileData.length > 7_000_000) return res.status(413).json({ error: 'File too large (max 5MB)' });

  const adminRec = req.user.role !== 'superadmin' ? getAdminRecord(req.user.id) : null;
  if (req.user.role === 'admin' && courseId) {
    if (!adminCourseIds(adminRec?.id).includes(Number(courseId))) return res.status(403).json({ error: 'Not your course' });
  }

  const m = {
    id: uuidv4(),
    type: type || 'note',
    courseId: courseId ? Number(courseId) : null,
    moduleIndex: (moduleIndex === undefined || moduleIndex === null || moduleIndex === '') ? null : Number(moduleIndex),
    batchId: batchId || null,
    adminId: adminRec?.id || null,
    adminName: req.user.name,
    title, description: description || '',
    fileData: null,
    hasFile: !!fileData,
    fileName: fileName || null,
    fileType: fileType || null,
    fileSize: fileSize || null,
    pinned: pinned || false,
    createdAt: new Date().toISOString(),
  };
  if (fileData) {
    if (store.available) store.putFile(m.id, fileData, fileName, fileType); // blob kept out of RAM
    else m.fileData = fileData; // JSON fallback keeps the blob inline
  }
  DB.materials.push(m);
  saveDB();
  // Return without fileData in the list response
  res.status(201).json({ ...m, fileData: undefined });
});

// Download a specific material file (returns full base64)
app.get('/api/materials/:id/download', auth, (req, res) => {
  if (!DB.materials) return res.status(404).json({ error: 'Not found' });
  const m = DB.materials.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });

  // Access check
  if (req.user.role === 'student') {
    const student = DB.students.find(s => s.userId === req.user.id);
    if (!student) return res.status(403).json({ error: 'Forbidden' });
    const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
    const hasAccess = (m.courseId && enrolled.includes(Number(m.courseId))) ||
                      (m.batchId && m.batchId === student.batchId);
    if (!hasAccess) return res.status(403).json({ error: 'Not enrolled' });
  }

  let data = m.fileData, fileName = m.fileName, fileType = m.fileType;
  if (!data && store.available) {
    const f = store.getFile(m.id); // load blob on demand from the files table
    if (f) { data = f.data; fileName = f.fileName || fileName; fileType = f.fileType || fileType; }
  }
  if (!data) return res.status(404).json({ error: 'No file attached' });
  res.json({ fileData: data, fileName, fileType });
});

app.put('/api/materials/:id', auth, adminOrSuper, (req, res) => {
  if (!DB.materials) return res.status(404).json({ error: 'Not found' });
  const idx = DB.materials.findIndex(m => m.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (DB.materials[idx].adminId !== adminRec?.id) return res.status(403).json({ error: 'Not yours' });
  }
  const { title, description, pinned } = req.body;
  DB.materials[idx] = { ...DB.materials[idx], title: title || DB.materials[idx].title, description: description ?? DB.materials[idx].description, pinned: pinned ?? DB.materials[idx].pinned };
  saveDB();
  res.json({ ...DB.materials[idx], fileData: undefined });
});

app.delete('/api/materials/:id', auth, adminOrSuper, (req, res) => {
  if (!DB.materials) return res.status(404).json({ error: 'Not found' });
  const m = DB.materials.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (m.adminId !== adminRec?.id) return res.status(403).json({ error: 'Not yours' });
  }
  DB.materials = DB.materials.filter(x => x.id !== req.params.id);
  if (store.available) store.delFile(req.params.id);
  saveDB();
  res.json({ success: true });
});

// ── COURSE TOPICS ──────────────────────────────────────────────────────────────
if (!DB.topics) DB.topics = [];

// GET all topics for a course (auth required — admin/super, or an enrolled student)
app.get('/api/courses/:courseId/topics', auth, (req, res) => {
  if (!DB.topics) DB.topics = [];
  const cId = Number(req.params.courseId);
  if (req.user.role === 'student') {
    const student = DB.students.find(s => s.userId === req.user.id);
    if (!student) return res.json([]);
    const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
    if (!enrolled.includes(cId)) return res.status(403).json({ error: 'Not enrolled' });
  }
  const topics = (DB.topics || []).filter(t => t.courseId === cId).sort((a, b) => a.order - b.order);
  res.json(topics);
});

// POST — add a new topic
app.post('/api/courses/:courseId/topics', auth, adminOrSuper, (req, res) => {
  if (!DB.topics) DB.topics = [];
  const cId = Number(req.params.courseId);
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(cId)) return res.status(403).json({ error: 'Not your course' });
  }
  const { title, duration, insertAfterOrder } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  // Shift orders down if inserting in the middle
  const insertAfter = insertAfterOrder != null && insertAfterOrder !== '' ? Number(insertAfterOrder) : null;
  if (insertAfter !== null) {
    DB.topics.filter(t => t.courseId === cId && t.order > insertAfter).forEach(t => { t.order += 1; });
  }
  const maxOrder = DB.topics.filter(t => t.courseId === cId).reduce((m, t) => Math.max(m, t.order), 0);
  const t = {
    id: uuidv4(),
    courseId: cId,
    adminId: req.user.role === 'admin' ? getAdminRecord(req.user.id)?.id : null,
    order: insertAfter !== null ? insertAfter + 1 : maxOrder + 1,
    title,
    duration: duration || '',
    createdAt: new Date().toISOString(),
  };
  DB.topics.push(t);
  saveDB();
  res.status(201).json(t);
});

// PUT — edit a topic (title / duration / order)
app.put('/api/courses/:courseId/topics/:topicId', auth, adminOrSuper, (req, res) => {
  if (!DB.topics) DB.topics = [];
  const cId = Number(req.params.courseId);
  const idx = DB.topics.findIndex(t => t.id === req.params.topicId && t.courseId === cId);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(cId)) return res.status(403).json({ error: 'Not your course' });
  }
  const { title, duration, order } = req.body;
  DB.topics[idx] = {
    ...DB.topics[idx],
    title: title ?? DB.topics[idx].title,
    duration: duration ?? DB.topics[idx].duration,
    order: order ?? DB.topics[idx].order,
  };
  saveDB();
  res.json(DB.topics[idx]);
});

// DELETE — remove a topic
app.delete('/api/courses/:courseId/topics/:topicId', auth, adminOrSuper, (req, res) => {
  if (!DB.topics) DB.topics = [];
  const cId = Number(req.params.courseId);
  const t = DB.topics.find(x => x.id === req.params.topicId && x.courseId === cId);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(cId)) return res.status(403).json({ error: 'Not your course' });
  }
  DB.topics = DB.topics.filter(x => x.id !== req.params.topicId);
  saveDB();
  res.json({ success: true });
});

// ── FORUM ─────────────────────────────────────────────────────────────────────
app.get('/api/forum', auth, (req, res) => res.json(DB.forum_posts));

app.post('/api/forum', auth, (req, res) => {
  const { title, body, courseId } = req.body;
  const post = { id: uuidv4(), authorId: req.user.id, authorName: req.user.name, role: req.user.role, title, body, courseId: courseId||null, replies: [], likes: 0, createdAt: new Date().toISOString() };
  DB.forum_posts.unshift(post);
  saveDB();
  res.status(201).json(post);
});

app.post('/api/forum/:id/reply', auth, (req, res) => {
  const idx = DB.forum_posts.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const reply = { id: uuidv4(), authorId: req.user.id, authorName: req.user.name, role: req.user.role, body: req.body.body, createdAt: new Date().toISOString() };
  DB.forum_posts[idx].replies.push(reply);
  saveDB();
  res.status(201).json(reply);
});

// ── EXPORT ────────────────────────────────────────────────────────────────────
app.get('/api/admin/export', auth, adminOrSuper, (req, res) => {
  let exportData;
  if (req.user.role === 'superadmin') {
    exportData = { exportedAt: new Date().toISOString(), scope: 'all', students: DB.students, enrollments: DB.enrollments, progress: DB.progress, quizResults: DB.quiz_results, courses: DB.courses, admins: DB.admins, batches: DB.batches };
  } else {
    const adminRec     = getAdminRecord(req.user.id);
    const myCourseIds  = adminCourseIds(adminRec?.id);
    const myStudentIds = studentsInCourses(myCourseIds);
    exportData = { exportedAt: new Date().toISOString(), scope: adminRec?.subject || 'admin', admin: adminRec?.name, courses: DB.courses.filter(c=>myCourseIds.includes(c.id)), students: DB.students.filter(s=>myStudentIds.includes(s.id)), enrollments: DB.enrollments.filter(e=>myCourseIds.includes(e.courseId)), progress: DB.progress.filter(p=>myCourseIds.includes(p.courseId)), quizResults: DB.quiz_results.filter(r=>myCourseIds.includes(r.courseId)) };
  }
  res.setHeader('Content-Disposition', `attachment; filename=dhishaai_export_${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.json(exportData);
});

// ── STUDY PLANNER ─────────────────────────────────────────────────────────────
// Stored on student record: student.studyPlan = [ { id, date, title, duration, done, courseId } ]
app.get('/api/study-plan', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(404).json({ error: 'Not found' });
  res.json(student.studyPlan || []);
});

app.post('/api/study-plan', auth, (req, res) => {
  const sidx = DB.students.findIndex(s => s.userId === req.user.id);
  if (sidx < 0) return res.status(404).json({ error: 'Not found' });
  if (!DB.students[sidx].studyPlan) DB.students[sidx].studyPlan = [];
  const item = { id: uuidv4(), date: req.body.date, title: req.body.title, duration: req.body.duration || 60, done: false, courseId: req.body.courseId || null, createdAt: new Date().toISOString() };
  DB.students[sidx].studyPlan.push(item);
  saveDB();
  res.json(item);
});

app.put('/api/study-plan/:id', auth, (req, res) => {
  const sidx = DB.students.findIndex(s => s.userId === req.user.id);
  if (sidx < 0) return res.status(404).json({ error: 'Not found' });
  const plan = DB.students[sidx].studyPlan || [];
  const idx  = plan.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  DB.students[sidx].studyPlan[idx] = { ...plan[idx], ...req.body };
  saveDB();
  res.json(DB.students[sidx].studyPlan[idx]);
});

app.delete('/api/study-plan/:id', auth, (req, res) => {
  const sidx = DB.students.findIndex(s => s.userId === req.user.id);
  if (sidx < 0) return res.status(404).json({ error: 'Not found' });
  DB.students[sidx].studyPlan = (DB.students[sidx].studyPlan || []).filter(p => p.id !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

// ── CAREER GOALS ──────────────────────────────────────────────────────────────
app.get('/api/career', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(404).json({ error: 'Not found' });
  res.json(student.careerGoals || { goal: '', targetRole: '', targetDate: '', notes: '', milestones: [] });
});

app.put('/api/career', auth, (req, res) => {
  const sidx = DB.students.findIndex(s => s.userId === req.user.id);
  if (sidx < 0) return res.status(404).json({ error: 'Not found' });
  DB.students[sidx].careerGoals = { ...(DB.students[sidx].careerGoals || {}), ...req.body };
  saveDB();
  res.json(DB.students[sidx].careerGoals);
});

// ── STATIC (production only - only when client/dist exists) ──────────────────
const distIndex = path.join(CLIENT_DIST, 'index.html');
if (fs.existsSync(distIndex)) {
  app.use(express.static(CLIENT_DIST));
  app.use(express.static(path.join(__dirname, '../client/public')));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    // Never cache the HTML shell, so browsers always load the latest built bundle.
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(distIndex);
  });
} else {
  // Dev mode: Vite handles frontend on port 3000, server only handles /api
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.status(200).send('API OK - client/dist not found; build the frontend to serve the app');
  });
}

loadDB();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 DhishaAI Enterprise LMS v5.0`);
  console.log(`\n✅ Open your browser at: http://localhost:${PORT}`);
  console.log(`\n👑 Super Admin : superadmin@dhishaai.com / superadmin123`);
  console.log(`📘 Python Admin: priya@dhishaai.com     / python123`);
  console.log(`📗 SQL Admin   : ravi@dhishaai.com      / sql123`);
  console.log(`📊 BI Admin    : divya@dhishaai.com     / powerbi123`);
  console.log(`🤖 ML Admin    : anil@dhishaai.com      / ml123`);
  console.log(`📋 Excel Admin : suma@dhishaai.com      / excel123`);
  console.log(`👤 Students    : rahul@email.com        / student123\n`);
});

// Flush any pending debounced write to disk on shutdown so no data is lost.
let _shuttingDown = false;
function shutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log('\n💾 Saving database before exit...');
  try { flushDB(); } catch (e) { console.error('Flush on exit failed:', e.message); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
