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
const os      = require('os');
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
app.use(express.json({ limit: '80mb' }));   // large enough for gallery video uploads (base64)
app.use(express.urlencoded({ limit: '80mb', extended: true }));

// Uploaded video files live on disk (streamed with range support) instead of in
// the DB. Served statically so seeking works and it plays inside the platform.
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VIDEO_DIR = path.join(UPLOADS_DIR, 'videos');
try { fs.mkdirSync(VIDEO_DIR, { recursive: true }); } catch {}
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));
function saveVideoFile(id, dataUrl) {
  const m = /^data:(.*?);base64,([\s\S]*)$/.exec(dataUrl || '');
  if (!m) return null;
  const mime = (m[1] || 'video/mp4').toLowerCase();
  const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogv' : (mime.includes('quicktime') || mime.includes('mov')) ? 'mov' : 'mp4';
  try { fs.writeFileSync(path.join(VIDEO_DIR, `${id}.${ext}`), Buffer.from(m[2], 'base64')); return `/uploads/videos/${id}.${ext}`; }
  catch (e) { console.error('video save failed:', e.message); return null; }
}
function deleteVideoFile(url) {
  if (!url || !String(url).startsWith('/uploads/videos/')) return;
  try { fs.unlinkSync(path.join(__dirname, String(url).replace(/^\//, ''))); } catch {}
}
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
  enroll_requests: [], // { id, studentId, studentName, courseId, courseTitle, status:'pending'|'approved'|'rejected', batchId, requestedAt, decidedAt, decidedBy }
  projects: [],     // { id, title, topic, description, assignType:'student'|'batch', studentId, batchId, courseId, maxMarks, adminId, adminName, createdAt, submissions:[{ studentId, studentName, link, note, submittedAt, marks, feedback, gradedAt, xpAwarded }] }
  group_sessions: [], // { id, hostId, hostName, courseId, topic, date, time, duration, note, createdAt, joiners:[{studentId, studentName}] } — student-run group study sessions
  lesson_videos: [],  // { id, courseId, moduleIndex, title, description, videoUrl, visible, order, adminId, adminName, createdAt } — admin-added recorded video lessons
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
    // `welcome: true` marks this as permanent — it is never auto-expired.
    { id: uuidv4(), userId: null, title: 'Welcome to DhishaAI LMS!', body: 'Your multi-subject learning platform is ready.', read: false, welcome: true, createdAt: new Date().toISOString() },
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
// Live completion %: computed from REAL learning units — every topic marked
// done, every sub-module PDF read, and every module quiz passed — divided by the
// total number of such units. Never a stale/stored number. Falls back to the
// stored percent only when a course genuinely has no completable units.
function livePercent(course, prog) {
  const clamp = n => Math.max(0, Math.min(100, Math.round(n || 0)));
  if (!course || !Array.isArray(course.modules)) return clamp(prog && prog.percent);
  const modules = course.modules;
  const done = (prog && prog.completedLessons) || [];
  const viewed = (prog && prog.viewedMaterials) || [];
  const studentId = prog && prog.studentId;
  const idxSet = new Set(modules.map((_, i) => i));
  const isRead = id => viewed.some(v => String(v) === String(id));
  const courseQuizzes = (DB.quizzes || []).filter(q => q.courseId === course.id);
  const untagged = courseQuizzes.filter(q => q.moduleIndex === undefined || q.moduleIndex === null);
  const quizForModule = i => courseQuizzes.find(q => q.moduleIndex === i) || untagged[i] || null;
  const matsForModule = i => (DB.materials || []).filter(m =>
    Number(m.courseId) === course.id &&
    (Number(m.moduleIndex) === i || (i === 0 && (m.moduleIndex === null || m.moduleIndex === undefined || m.moduleIndex === '' || !idxSet.has(Number(m.moduleIndex))))));
  const passed = q => !!q && (DB.quiz_results || []).some(r => r.studentId === studentId && r.quizId === q.id && r.total && r.score / r.total >= 0.7);
  let total = 0, dn = 0, gi = 0;
  modules.forEach((m, i) => {
    (m.topics || []).forEach(() => { total++; if (done.includes(gi)) dn++; gi++; });
    matsForModule(i).forEach(mat => { total++; if (isRead(mat.id)) dn++; });
    const q = quizForModule(i); if (q) { total++; if (passed(q)) dn++; }
  });
  if (total === 0) return clamp(prog && prog.percent);
  return clamp((dn / total) * 100);
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
    experience: s.experience || '', company: s.company || '', qualification: s.qualification || '',
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

// ── ENROLLMENT REQUESTS (student requests → admin approves) ───────────────────
function notify(userId, title, body, type) {
  if (!userId) return;
  DB.notifications.push({ id: uuidv4(), userId, title, body, type: type || null, read: false, createdAt: new Date().toISOString() });
}
function notifyCourseAdmins(course, title, body, type) {
  const targets = new Set();
  if (course && course.ownerId) {
    const owner = DB.admins.find(a => a.id === course.ownerId);
    if (owner && owner.userId) targets.add(owner.userId);
  }
  DB.users.filter(u => u.role === 'superadmin').forEach(u => targets.add(u.id));
  targets.forEach(uid => notify(uid, title, body, type));
}

// Catalog: every course + this student's status (enrolled / pending / available).
app.get('/api/courses/catalog', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.json([]);
  const enrolled = new Set(DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId));
  const pending  = new Set((DB.enroll_requests || []).filter(r => r.studentId === student.id && r.status === 'pending').map(r => r.courseId));
  res.json(DB.courses.map(c => {
    const owner = DB.admins.find(a => a.id === c.ownerId);
    const status = enrolled.has(c.id) ? 'enrolled' : pending.has(c.id) ? 'pending' : 'available';
    return { id: c.id, title: c.title, category: c.category, color: c.color, duration: c.duration, description: c.description, instructorName: owner?.name || 'DhishaAI', status };
  }));
});

// Student asks to enroll in a course.
app.post('/api/enroll-requests', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(403).json({ error: 'Students only' });
  if (!Array.isArray(DB.enroll_requests)) DB.enroll_requests = [];
  const courseId = Number(req.body.courseId);
  const course = DB.courses.find(c => c.id === courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (DB.enrollments.find(e => e.studentId === student.id && e.courseId === courseId)) return res.status(400).json({ error: 'Already enrolled' });
  if (DB.enroll_requests.find(r => r.studentId === student.id && r.courseId === courseId && r.status === 'pending')) return res.status(400).json({ error: 'Request already pending' });
  const reqObj = { id: uuidv4(), studentId: student.id, studentName: student.name, studentEmail: student.email, courseId, courseTitle: course.title, status: 'pending', batchId: student.batchId || null, requestedAt: new Date().toISOString() };
  DB.enroll_requests.push(reqObj);
  notifyCourseAdmins(course, 'New enrollment request', `📩 ${student.name} requested to enroll in "${course.title}". Approve or reject in My Students → Enrollment Requests.`, 'enroll_request');
  saveDB();
  res.status(201).json(reqObj);
});

// Student cancels their own pending request.
app.delete('/api/enroll-requests/:id', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  const r = (DB.enroll_requests || []).find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!student || r.studentId !== student.id) return res.status(403).json({ error: 'Not yours' });
  DB.enroll_requests = DB.enroll_requests.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ success: true });
});

// Admin/super: list PENDING requests for their courses.
app.get('/api/enroll-requests', auth, adminOrSuper, (req, res) => {
  let reqs = (DB.enroll_requests || []).filter(r => r.status === 'pending');
  if (req.user.role !== 'superadmin') {
    const myCourseIds = adminCourseIds(getAdminRecord(req.user.id)?.id);
    reqs = reqs.filter(r => myCourseIds.includes(r.courseId));
  }
  reqs.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  res.json(reqs);
});

function canDecide(req, r) {
  if (req.user.role === 'superadmin') return true;
  return adminCourseIds(getAdminRecord(req.user.id)?.id).includes(r.courseId);
}

// Admin/super approves a request (optionally assigning the student's batch).
app.post('/api/enroll-requests/:id/approve', auth, adminOrSuper, (req, res) => {
  const r = (DB.enroll_requests || []).find(x => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Request not found' });
  if (!canDecide(req, r)) return res.status(403).json({ error: 'Not your course' });
  const course = DB.courses.find(c => c.id === r.courseId);
  const student = DB.students.find(s => s.id === r.studentId);
  if (!course || !student) return res.status(404).json({ error: 'Course or student missing' });
  if (!DB.enrollments.find(e => e.studentId === student.id && e.courseId === r.courseId))
    DB.enrollments.push({ id: uuidv4(), studentId: student.id, courseId: r.courseId, enrolledAt: new Date().toISOString() });
  if (!DB.progress.find(p => p.studentId === student.id && p.courseId === r.courseId))
    DB.progress.push({ id: uuidv4(), studentId: student.id, courseId: r.courseId, percent: 0, completedLessons: [], lastActivity: new Date().toISOString() });
  const batchId = req.body.batchId;
  if (batchId) { const sidx = DB.students.findIndex(s => s.id === student.id); if (sidx >= 0) DB.students[sidx].batchId = batchId; }
  r.status = 'approved'; r.decidedAt = new Date().toISOString(); r.decidedBy = req.user.name; r.batchId = batchId || r.batchId || null;
  notify(student.userId, 'Enrollment approved 🎉', `You've been enrolled in "${course.title}". Happy learning!`, 'enroll_approved');
  saveDB();
  res.json({ success: true });
});

// Admin/super rejects a request.
app.post('/api/enroll-requests/:id/reject', auth, adminOrSuper, (req, res) => {
  const r = (DB.enroll_requests || []).find(x => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Request not found' });
  if (!canDecide(req, r)) return res.status(403).json({ error: 'Not your course' });
  r.status = 'rejected'; r.decidedAt = new Date().toISOString(); r.decidedBy = req.user.name;
  const student = DB.students.find(s => s.id === r.studentId);
  if (student) notify(student.userId, 'Enrollment request declined', `Your request to enroll in "${r.courseTitle}" was not approved. Please contact your admin.`, 'enroll_rejected');
  saveDB();
  res.json({ success: true });
});

// ── PROJECTS (admin assigns → student submits → admin grades → XP) ────────────
// Admin/super creates & assigns a project to one student OR a whole batch.
app.post('/api/projects', auth, adminOrSuper, (req, res) => {
  const { title, topic, description, assignType, studentId, batchId, courseId, maxMarks, fileData, fileName, fileType } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  if (!['student', 'batch'].includes(assignType)) return res.status(400).json({ error: 'assignType must be student or batch' });
  if (fileData && fileData.length > 7_000_000) return res.status(413).json({ error: 'Attachment too large (max 5MB)' });
  if (!Array.isArray(DB.projects)) DB.projects = [];
  const adminRec = req.user.role === 'admin' ? getAdminRecord(req.user.id) : null;
  let sId = null, bId = null;
  if (assignType === 'student') {
    sId = Number(studentId);
    const student = DB.students.find(s => s.id === sId);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (req.user.role === 'admin' && !studentsInCourses(adminCourseIds(adminRec?.id)).includes(sId)) return res.status(403).json({ error: 'Not your student' });
  } else {
    bId = String(batchId || '');
    if (!bId) return res.status(400).json({ error: 'Batch required' });
  }
  const proj = {
    id: uuidv4(), title, topic: topic || '', description: description || '',
    assignType, studentId: sId, batchId: bId,
    courseId: courseId ? Number(courseId) : null,
    maxMarks: Number(maxMarks) > 0 ? Number(maxMarks) : 100,
    // Optional brief/reference file the admin attaches (stored inline so it
    // survives on the JSON-fallback store too).
    fileData: fileData || null, fileName: fileName || null, fileType: fileType || null,
    adminId: adminRec?.id || null, adminName: req.user.name,
    createdAt: new Date().toISOString(), submissions: [],
  };
  DB.projects.push(proj);
  const recipients = assignType === 'student' ? DB.students.filter(s => s.id === sId) : DB.students.filter(s => s.batchId === bId);
  recipients.forEach(s => notify(s.userId, 'New project assigned 📌', `You've been assigned the project "${title}". Open Projects to submit your work.`, 'project'));
  saveDB();
  res.status(201).json(proj);
});

// Admin/super: list projects they created (super sees all), each with per-student rows.
app.get('/api/projects', auth, adminOrSuper, (req, res) => {
  let list = DB.projects || [];
  if (req.user.role !== 'superadmin') {
    const adminRec = getAdminRecord(req.user.id);
    list = list.filter(p => p.adminId === adminRec?.id);
  }
  const out = list.map(p => {
    const recipients = p.assignType === 'student'
      ? DB.students.filter(x => x.id === p.studentId)
      : DB.students.filter(x => x.batchId === p.batchId);
    const b = p.assignType === 'batch' ? DB.batches.find(x => x.id === p.batchId) : null;
    const assigneeName = p.assignType === 'student' ? (recipients[0]?.name || 'Student') : (b?.name || p.batchId);
    const rows = recipients.map(s => {
      const sub = (p.submissions || []).find(x => x.studentId === s.id);
      return { studentId: s.id, studentName: s.name, link: sub?.link || '', note: sub?.note || '', submittedAt: sub?.submittedAt || null, marks: sub?.marks ?? null, feedback: sub?.feedback || '', gradedAt: sub?.gradedAt || null, hasSubmissionFile: !!sub?.fileData, submissionFileName: sub?.fileName || null };
    });
    const { fileData, ...rest } = p; // don't ship the blob in the list
    return { ...rest, hasFile: !!fileData, assigneeName, rows };
  }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(out);
});

// Student: projects assigned to me (individually or via my batch) + my submission.
app.get('/api/my-projects', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.json([]);
  const mine = (DB.projects || []).filter(p =>
    (p.assignType === 'student' && p.studentId === student.id) ||
    (p.assignType === 'batch' && p.batchId && p.batchId === student.batchId)
  );
  res.json(mine.map(p => {
    const sub = (p.submissions || []).find(x => x.studentId === student.id) || null;
    const course = p.courseId ? DB.courses.find(c => c.id === p.courseId) : null;
    return {
      id: p.id, title: p.title, topic: p.topic, description: p.description, maxMarks: p.maxMarks,
      adminName: p.adminName, createdAt: p.createdAt, courseTitle: course?.title || null,
      hasFile: !!p.fileData, fileName: p.fileName || null,
      hasSubmissionFile: !!sub?.fileData, submissionFileName: sub?.fileName || null,
      link: sub?.link || '', note: sub?.note || '', submittedAt: sub?.submittedAt || null,
      marks: sub?.marks ?? null, feedback: sub?.feedback || '', gradedAt: sub?.gradedAt || null,
      status: sub?.gradedAt ? 'graded' : sub?.submittedAt ? 'submitted' : 'assigned',
    };
  }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

// Download the project's attached brief file. Allowed for super, the owning
// admin, or a student the project is assigned to (individually or via batch).
app.get('/api/projects/:id/file', auth, (req, res) => {
  const p = (DB.projects || []).find(x => x.id === req.params.id);
  if (!p || !p.fileData) return res.status(404).json({ error: 'No attachment' });
  let ok = false;
  if (req.user.role === 'superadmin') ok = true;
  else if (req.user.role === 'admin') { const a = getAdminRecord(req.user.id); ok = p.adminId === a?.id; }
  else {
    const s = DB.students.find(x => x.userId === req.user.id);
    ok = !!s && ((p.assignType === 'student' && p.studentId === s.id) || (p.assignType === 'batch' && p.batchId === s.batchId));
  }
  if (!ok) return res.status(403).json({ error: 'Not allowed' });
  res.json({ fileData: p.fileData, fileName: p.fileName, fileType: p.fileType });
});

// Download a student's submitted file. Allowed for super, the owning admin, or
// the student who submitted it. studentId query selects whose submission (admins).
app.get('/api/projects/:id/submission-file', auth, (req, res) => {
  const p = (DB.projects || []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  let studentId = Number(req.query.studentId);
  if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
    const s = DB.students.find(x => x.userId === req.user.id);
    if (!s) return res.status(403).json({ error: 'Not allowed' });
    studentId = s.id; // students can only fetch their own
  } else if (req.user.role === 'admin' && p.adminId !== getAdminRecord(req.user.id)?.id) {
    return res.status(403).json({ error: 'Not your project' });
  }
  const sub = (p.submissions || []).find(x => x.studentId === studentId);
  if (!sub || !sub.fileData) return res.status(404).json({ error: 'No submitted file' });
  res.json({ fileData: sub.fileData, fileName: sub.fileName, fileType: sub.fileType });
});

// Student submits (a link and/or an attached file, + optional note).
app.post('/api/projects/:id/submit', auth, (req, res) => {
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(403).json({ error: 'Students only' });
  const p = (DB.projects || []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const eligible = (p.assignType === 'student' && p.studentId === student.id) || (p.assignType === 'batch' && p.batchId === student.batchId);
  if (!eligible) return res.status(403).json({ error: 'Not assigned to you' });
  const { fileData, fileName, fileType } = req.body;
  if (fileData && fileData.length > 7_000_000) return res.status(413).json({ error: 'Attachment too large (max 5MB)' });
  if (!Array.isArray(p.submissions)) p.submissions = [];
  let sub = p.submissions.find(x => x.studentId === student.id);
  if (!sub) { sub = { studentId: student.id, studentName: student.name }; p.submissions.push(sub); }
  sub.link = String(req.body.link || '').slice(0, 500);
  sub.note = String(req.body.note || '').slice(0, 2000);
  if (fileData) { sub.fileData = fileData; sub.fileName = fileName || 'submission'; sub.fileType = fileType || null; }
  sub.submittedAt = new Date().toISOString();
  const owner = p.adminId ? DB.admins.find(a => a.id === p.adminId) : null;
  if (owner?.userId) notify(owner.userId, 'Project submitted', `${student.name} submitted the project "${p.title}".`, 'project_submitted');
  else DB.users.filter(u => u.role === 'superadmin').forEach(u => notify(u.id, 'Project submitted', `${student.name} submitted "${p.title}".`, 'project_submitted'));
  saveDB();
  res.json({ success: true });
});

// Admin/super grades one student's submission. XP = marks, applied as a DELTA so
// re-grading never double-counts and never misses.
app.post('/api/projects/:id/grade', auth, adminOrSuper, (req, res) => {
  const p = (DB.projects || []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (req.user.role === 'admin' && p.adminId !== getAdminRecord(req.user.id)?.id) return res.status(403).json({ error: 'Not your project' });
  const studentId = Number(req.body.studentId);
  const sidx = DB.students.findIndex(s => s.id === studentId);
  if (sidx < 0) return res.status(404).json({ error: 'Student not found' });
  const marks = Math.max(0, Math.min(Number(req.body.marks) || 0, p.maxMarks));
  if (!Array.isArray(p.submissions)) p.submissions = [];
  let sub = p.submissions.find(x => x.studentId === studentId);
  if (!sub) { sub = { studentId, studentName: DB.students[sidx].name }; p.submissions.push(sub); }
  const prevXp = sub.xpAwarded || 0;   // idempotent XP accounting
  const newXp = marks;
  DB.students[sidx].xp = Math.max(0, (DB.students[sidx].xp || 0) + (newXp - prevXp));
  sub.marks = marks; sub.feedback = String(req.body.feedback || '').slice(0, 2000); sub.gradedAt = new Date().toISOString(); sub.xpAwarded = newXp;
  notify(DB.students[sidx].userId, 'Project graded ✅', `Your project "${p.title}" was graded ${marks}/${p.maxMarks}. XP earned for it: ${newXp}.`, 'project_graded');
  saveDB();
  res.json({ success: true, awardedXp: newXp });
});

// Admin/super deletes a project; reclaims any XP it awarded so totals stay exact.
app.delete('/api/projects/:id', auth, adminOrSuper, (req, res) => {
  const p = (DB.projects || []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'admin' && p.adminId !== getAdminRecord(req.user.id)?.id) return res.status(403).json({ error: 'Not yours' });
  (p.submissions || []).forEach(sub => {
    if (sub.xpAwarded) { const i = DB.students.findIndex(s => s.id === sub.studentId); if (i >= 0) DB.students[i].xp = Math.max(0, (DB.students[i].xp || 0) - sub.xpAwarded); }
  });
  DB.projects = DB.projects.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ success: true });
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

  const body = { ...req.body };
  // Admin can only edit their own courses — and can NEVER change ownership.
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    if (DB.courses[idx].ownerId !== adminRec?.id) return res.status(403).json({ error: 'Not your course' });
    delete body.ownerId; // only the superadmin can reassign a course to another admin
  } else if ('ownerId' in body) {
    body.ownerId = body.ownerId || null; // superadmin: "" → unassigned
  }

  DB.courses[idx] = { ...DB.courses[idx], ...body, id };
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

// Admin controls which lessons/modules students can access (teaching pace).
// manualRelease=false -> auto-unlock by completion (default). true -> only the
// module indexes in releasedModules are unlocked for students.
app.put('/api/courses/:id/lesson-release', auth, adminOrSuper, (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = DB.courses.findIndex(c => c.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (!canEditCourse(req, DB.courses[idx])) return res.status(403).json({ error: 'Not your course' });
  const { manualRelease, releasedModules } = req.body;
  if (manualRelease !== undefined) DB.courses[idx].manualRelease = !!manualRelease;
  if (Array.isArray(releasedModules)) DB.courses[idx].releasedModules = [...new Set(releasedModules.map(Number).filter(n => Number.isInteger(n) && n >= 0))];
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
  const { title, topics, insertAt } = req.body;
  const mod = { title: title || `Module ${c.modules.length + 1}`, topics: Array.isArray(topics) ? topics.filter(t => t && t.trim()).map(t => t.trim()) : [] };
  const wasLen = c.modules.length;
  // insertAt (0-based) lets the admin place the module at a chosen position;
  // null/blank appends to the end.
  const pos = (insertAt === undefined || insertAt === null || insertAt === '')
    ? wasLen : Math.max(0, Math.min(wasLen, parseInt(insertAt)));
  c.modules.splice(pos, 0, mod);
  // Keep attached notes/quizzes aligned with their module after an insert.
  if (pos < wasLen) {
    DB.materials.forEach(m => { if (Number(m.courseId) === id && m.moduleIndex != null && m.moduleIndex >= pos) m.moduleIndex += 1; });
    DB.quizzes.forEach(q => { if (q.courseId === id && q.moduleIndex != null && q.moduleIndex >= pos) q.moduleIndex += 1; });
  }
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
  const { name, email, password, batchId, phone, enrolledCourses, experience, company, qualification } = req.body;
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
  DB.students.push({ id: sid, userId: uid, name, email, batchId: batchId||'', xp: 0, streak: 0, badges: 0, phone: phone||'', experience: experience||'', company: company||'', qualification: qualification||'', joined: new Date().toISOString() });

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

  const { name, batchId, phone, enrolledCourses, experience, company, qualification } = req.body;
  DB.students[idx] = {
    ...DB.students[idx],
    name: name || DB.students[idx].name,
    batchId: batchId || DB.students[idx].batchId,
    phone: phone ?? DB.students[idx].phone,
    experience: experience ?? (DB.students[idx].experience || ''),
    company: company ?? (DB.students[idx].company || ''),
    qualification: qualification ?? (DB.students[idx].qualification || ''),
  };

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

// Record that a student has read a study material (PDF) all the way to the last
// page. The module can only be completed — and the next module/quiz unlocked —
// once every material attached to it has been read to the end.
app.post('/api/progress/material-viewed', auth, (req, res) => {
  const { courseId, materialId } = req.body;
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.status(400).json({ error: 'Student not found' });
  const cid = Number(courseId);
  // Must be enrolled in the course this material belongs to.
  if (!DB.enrollments.some(e => e.studentId === student.id && e.courseId === cid))
    return res.status(403).json({ error: 'Not enrolled in this course' });
  const mat = DB.materials.find(m => String(m.id) === String(materialId) && Number(m.courseId) === cid);
  if (!mat) return res.status(404).json({ error: 'Material not found' });
  let prog = DB.progress.find(p => p.studentId === student.id && p.courseId === cid);
  if (!prog) {
    prog = { id: uuidv4(), studentId: student.id, courseId: cid, percent: 0, completedLessons: [], viewedMaterials: [], lastActivity: new Date().toISOString() };
    DB.progress.push(prog);
  }
  if (!Array.isArray(prog.viewedMaterials)) prog.viewedMaterials = [];
  if (!prog.viewedMaterials.some(v => String(v) === String(materialId))) {
    prog.viewedMaterials.push(materialId);
    prog.lastActivity = new Date().toISOString();
    saveDB();
  }
  res.json({ success: true, viewedMaterials: prog.viewedMaterials });
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
const NOTIF_TTL_MS = Number(process.env.NOTIF_TTL_MS) || 7 * 24 * 60 * 60 * 1000; // notifications auto-expire after 1 week
// The welcome broadcast is permanent; everything else disappears after a week.
const isWelcomeNotif = n => n.welcome === true || /^welcome/i.test(n.title || '');
function pruneExpiredNotifications() {
  const cutoff = Date.now() - NOTIF_TTL_MS;
  const before = DB.notifications.length;
  DB.notifications = DB.notifications.filter(n =>
    isWelcomeNotif(n) || !n.createdAt || new Date(n.createdAt).getTime() >= cutoff);
  if (DB.notifications.length !== before) saveDB();
}
app.get('/api/notifications', auth, (req, res) => {
  pruneExpiredNotifications();
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
const shapeAssignment = a => { const { fileData, ...rest } = a; return { ...rest, hasFile: !!fileData }; };
app.get('/api/assignments', auth, (req, res) => {
  if (req.user.role === 'superadmin') return res.json(DB.assignments.map(shapeAssignment));
  if (req.user.role === 'admin') {
    const adminRec = getAdminRecord(req.user.id);
    const myCourseIds = adminCourseIds(adminRec?.id);
    return res.json(DB.assignments.filter(a => myCourseIds.includes(a.courseId)).map(shapeAssignment));
  }
  const student  = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.json([]);
  const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
  // also include batch-targeted assignments
  const batchAssignments = DB.assignments.filter(a => a.batchId && a.batchId === student.batchId);
  const courseAssignments = DB.assignments.filter(a => a.courseId && enrolled.includes(a.courseId));
  const all = [...new Map([...batchAssignments, ...courseAssignments].map(a => [a.id, a])).values()];
  res.json(all.map(shapeAssignment));
});

app.post('/api/assignments', auth, adminOrSuper, (req, res) => {
  const { courseId, batchId, title, description, dueDate, fileData, fileName, fileType } = req.body;
  if (req.user.role === 'admin' && courseId) {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(Number(courseId))) return res.status(403).json({ error: 'Not your course' });
  }
  if (fileData && fileData.length > 7_000_000) return res.status(413).json({ error: 'Attachment too large (max 5MB)' });
  const adminRec = req.user.role !== 'superadmin' ? getAdminRecord(req.user.id) : null;
  const a = { id: uuidv4(), courseId: courseId || null, batchId: batchId || null, adminId: adminRec?.id || null, adminName: req.user.name, title, description, dueDate: dueDate || null,
    fileData: fileData || null, fileName: fileName || null, fileType: fileType || null,
    createdAt: new Date().toISOString() };
  DB.assignments.push(a);
  saveDB();
  res.status(201).json(shapeAssignment(a));
});

// Download an assignment's attached file (target students, owning admin, super).
app.get('/api/assignments/:id/file', auth, (req, res) => {
  const a = DB.assignments.find(x => x.id === req.params.id);
  if (!a || !a.fileData) return res.status(404).json({ error: 'No attachment' });
  let ok = false;
  if (req.user.role === 'superadmin') ok = true;
  else if (req.user.role === 'admin') { const ar = getAdminRecord(req.user.id); ok = a.adminId === ar?.id || adminCourseIds(ar?.id).includes(Number(a.courseId)); }
  else {
    const s = DB.students.find(x => x.userId === req.user.id);
    if (s) { const enrolled = DB.enrollments.some(e => e.studentId === s.id && e.courseId === a.courseId); ok = (a.courseId && enrolled) || (a.batchId && a.batchId === s.batchId); }
  }
  if (!ok) return res.status(403).json({ error: 'Not allowed' });
  res.json({ fileData: a.fileData, fileName: a.fileName, fileType: a.fileType });
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
  const { courseId, batchId, title, description, type, fileData, fileName, fileType, fileSize, pinned, moduleIndex, order } = req.body;
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
    order: (order === undefined || order === null || order === '') ? null : Number(order),
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
  const { title, description, pinned, courseId, moduleIndex, order } = req.body;
  const cur = DB.materials[idx];
  // If an admin is moving this to a course, it must be one of theirs.
  if (req.user.role === 'admin' && courseId !== undefined && courseId !== null && courseId !== '') {
    const adminRec = getAdminRecord(req.user.id);
    if (!adminCourseIds(adminRec?.id).includes(Number(courseId))) return res.status(403).json({ error: 'Not your course' });
  }
  DB.materials[idx] = {
    ...cur,
    title: title || cur.title,
    description: description ?? cur.description,
    pinned: pinned ?? cur.pinned,
    courseId: courseId !== undefined ? (courseId === '' || courseId === null ? null : Number(courseId)) : cur.courseId,
    moduleIndex: moduleIndex !== undefined ? (moduleIndex === '' || moduleIndex === null ? null : Number(moduleIndex)) : cur.moduleIndex,
    order: order !== undefined ? (order === '' || order === null ? null : Number(order)) : cur.order,
  };
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

// ── CSV EXPORTS (open in Excel) ───────────────────────────────────────────────
function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(headers, rows) {
  // Leading BOM so Excel reads UTF-8 (names, ₹, etc.) correctly.
  return '﻿' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
}
const inDate = d => d ? new Date(d).toLocaleDateString('en-IN') : '';

// Students roster CSV — superadmin: all students; admin: only their students.
app.get('/api/admin/export/students.csv', auth, adminOrSuper, (req, res) => {
  let students;
  if (req.user.role === 'superadmin') {
    students = DB.students;
  } else {
    const adminRec = getAdminRecord(req.user.id);
    const ids = studentsInCourses(adminCourseIds(adminRec?.id));
    students = DB.students.filter(s => ids.includes(s.id));
  }
  const headers = ['Name', 'Email', 'Phone', 'Qualification', 'Experience', 'Company', 'Batch', 'Courses Enrolled', 'Avg Progress %', 'Quiz Avg %', 'XP', 'Streak (days)', 'Status', 'Last Active', 'Joined'];
  const rows = students.map(s => {
    const r = studentReport(s);
    return [r.name, r.email, r.phone, r.qualification, r.experience, r.company, r.batchName, r.courses.length, r.avgProgress, r.quizAvg, r.xp, r.streak, r.active ? 'Active' : 'Inactive', inDate(r.lastActivity), inDate(s.joined)];
  });
  sendCsv(res, `dhishaai_students_${Date.now()}.csv`, toCsv(headers, rows));
});

// Admins roster CSV — super admin only.
app.get('/api/admin/export/admins.csv', auth, adminOrSuper, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Super admin only' });
  const headers = ['Name', 'Email', 'Subject(s)', 'Courses Owned', 'Students', 'Phone', 'Created'];
  const rows = DB.admins.map(a => {
    const courseIds = adminCourseIds(a.id);
    const subjects = (a.subjects && a.subjects.length) ? a.subjects.join('; ') : (a.subject || '');
    return [a.name, a.email, subjects, courseIds.length, studentsInCourses(courseIds).length, a.phone || '', inDate(a.createdAt)];
  });
  sendCsv(res, `dhishaai_admins_${Date.now()}.csv`, toCsv(headers, rows));
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

// ── ONLINE / GROUP STUDY SESSIONS ─────────────────────────────────────────────
// A student REQUESTS to host an online session on a topic. The course's admin
// approves and attaches the Google Meet link (or rejects). Only then do
// coursemates see it and can join to get the link. A recording link can be added
// afterwards so students who missed it can watch.
function sessionCourseOwnerId(g) {
  const c = g.courseId ? DB.courses.find(x => x.id === g.courseId) : null;
  return c ? c.ownerId : null;
}
function canModerateSession(req, g) {
  if (req.user.role === 'superadmin') return true;
  if (req.user.role === 'admin') { const a = getAdminRecord(req.user.id); return !!a && sessionCourseOwnerId(g) === a.id; }
  return false;
}
// `full` (admin view or link-holder) sees the Meet link regardless; students see
// the link only once approved AND they are the host or have joined.
function shapeGroupSession(g, me, full) {
  const course = g.courseId ? DB.courses.find(c => c.id === g.courseId) : null;
  const joiners = g.joiners || [];
  const isHost = !!me && g.hostId === me.id;
  const joined = !!me && joiners.some(j => j.studentId === me.id);
  const canSeeLink = full || (g.status === 'approved' && (isHost || joined));
  return {
    id: g.id, hostId: g.hostId, hostName: g.hostName, courseId: g.courseId,
    courseTitle: course?.title || null, topic: g.topic, reason: g.reason || '',
    date: g.date, time: g.time || '', duration: g.duration || 60, note: g.note || '',
    status: g.status || 'pending',
    videoLink: canSeeLink ? (g.videoLink || '') : '',
    hasVideoLink: !!g.videoLink,
    recordingLink: g.recordingLink || '',
    createdAt: g.createdAt, joiners, joinerCount: joiners.length,
    isHost, joined,
  };
}
// Student view: my own requests (any status) + APPROVED sessions on my courses.
app.get('/api/group-sessions', auth, (req, res) => {
  const me = DB.students.find(s => s.userId === req.user.id);
  if (!me) return res.json([]);
  const myCourseIds = DB.enrollments.filter(e => e.studentId === me.id).map(e => e.courseId);
  const list = (DB.group_sessions || []).filter(g =>
    g.hostId === me.id || (g.status === 'approved' && g.courseId && myCourseIds.includes(g.courseId)));
  const today = new Date().toISOString().split('T')[0];
  const out = list.map(g => shapeGroupSession(g, me))
    .sort((a, b) => (a.date === b.date ? (a.time || '').localeCompare(b.time || '') : a.date.localeCompare(b.date)));
  res.json([...out.filter(g => g.date >= today), ...out.filter(g => g.date < today).reverse()]);
});
// Admin/super view: all sessions on their courses (pending first) with links.
app.get('/api/group-sessions/manage', auth, adminOrSuper, (req, res) => {
  let list = DB.group_sessions || [];
  if (req.user.role !== 'superadmin') {
    const a = getAdminRecord(req.user.id);
    const myCourseIds = adminCourseIds(a?.id);
    list = list.filter(g => g.courseId && myCourseIds.includes(g.courseId));
  }
  const rank = s => (s === 'pending' ? 0 : s === 'approved' ? 1 : 2);
  const out = list.map(g => shapeGroupSession(g, null, true))
    .sort((a, b) => rank(a.status) - rank(b.status) || (b.createdAt < a.createdAt ? -1 : 1));
  res.json(out);
});
// Student requests to host a session.
app.post('/api/group-sessions', auth, (req, res) => {
  const me = DB.students.find(s => s.userId === req.user.id);
  if (!me) return res.status(403).json({ error: 'Students only' });
  const { courseId, topic, reason, date, time, duration, note } = req.body;
  if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });
  if (!date) return res.status(400).json({ error: 'Date is required' });
  if (!courseId) return res.status(400).json({ error: 'Pick the course this session is for' });
  if (!DB.enrollments.some(e => e.studentId === me.id && e.courseId === Number(courseId)))
    return res.status(403).json({ error: 'You are not enrolled in that course' });
  if (!Array.isArray(DB.group_sessions)) DB.group_sessions = [];
  const g = {
    id: uuidv4(), hostId: me.id, hostName: me.name, courseId: Number(courseId),
    topic: String(topic).slice(0, 200), reason: String(reason || '').slice(0, 500),
    date, time: time || '', duration: Number(duration) > 0 ? Number(duration) : 60,
    note: String(note || '').slice(0, 500),
    status: 'pending', videoLink: '', recordingLink: '',
    createdAt: new Date().toISOString(),
    joiners: [{ studentId: me.id, studentName: me.name }], // host is in by default
  };
  DB.group_sessions.push(g);
  // Notify the course's admin(s) to review the request.
  const course = DB.courses.find(c => c.id === g.courseId);
  notifyCourseAdmins(course, 'Online session request 🎥', `${me.name} wants to host "${g.topic}" for ${course?.title || 'a course'} on ${g.date}${g.time ? ' at ' + g.time : ''}. Approve & add the Meet link in Online Sessions.`, 'session_request');
  saveDB();
  res.status(201).json(shapeGroupSession(g, me));
});
// Admin approves and attaches the Google Meet link.
app.post('/api/group-sessions/:id/approve', auth, adminOrSuper, (req, res) => {
  const g = (DB.group_sessions || []).find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if (!canModerateSession(req, g)) return res.status(403).json({ error: 'Not your course' });
  const link = String(req.body.videoLink || '').trim();
  if (!link) return res.status(400).json({ error: 'Add the Google Meet (video) link' });
  g.status = 'approved'; g.videoLink = link.slice(0, 500);
  const host = DB.students.find(s => s.id === g.hostId);
  if (host?.userId) notify(host.userId, 'Your session is approved ✅', `Your online session "${g.topic}" is approved. Meet link: ${g.videoLink}`, 'session_approved');
  // Tell coursemates they can join.
  const mates = DB.enrollments.filter(e => e.courseId === g.courseId && e.studentId !== g.hostId).map(e => e.studentId);
  [...new Set(mates)].forEach(sid => {
    const s = DB.students.find(x => x.id === sid);
    if (s?.userId) notify(s.userId, 'Online session 🎥', `${g.hostName} is hosting "${g.topic}" on ${g.date}${g.time ? ' at ' + g.time : ''}. Join from Study Planner to get the link.`, 'session_approved');
  });
  saveDB();
  res.json(shapeGroupSession(g, null, true));
});
app.post('/api/group-sessions/:id/reject', auth, adminOrSuper, (req, res) => {
  const g = (DB.group_sessions || []).find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if (!canModerateSession(req, g)) return res.status(403).json({ error: 'Not your course' });
  g.status = 'rejected';
  const host = DB.students.find(s => s.id === g.hostId);
  if (host?.userId) notify(host.userId, 'Session request declined', `Your online session request "${g.topic}" was not approved.${req.body.reason ? ' Reason: ' + req.body.reason : ''}`, 'session_rejected');
  saveDB();
  res.json(shapeGroupSession(g, null, true));
});
// Host or moderator adds/updates the recording link after the session.
app.post('/api/group-sessions/:id/recording', auth, (req, res) => {
  const g = (DB.group_sessions || []).find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const me = DB.students.find(s => s.userId === req.user.id);
  const isHost = me && g.hostId === me.id;
  if (!isHost && !canModerateSession(req, g)) return res.status(403).json({ error: 'Not allowed' });
  g.recordingLink = String(req.body.recordingLink || '').trim().slice(0, 500);
  saveDB();
  res.json(shapeGroupSession(g, me, true));
});
app.post('/api/group-sessions/:id/join', auth, (req, res) => {
  const me = DB.students.find(s => s.userId === req.user.id);
  if (!me) return res.status(403).json({ error: 'Students only' });
  const g = (DB.group_sessions || []).find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if (g.status !== 'approved') return res.status(400).json({ error: 'This session is not approved yet' });
  const myCourseIds = DB.enrollments.filter(e => e.studentId === me.id).map(e => e.courseId);
  if (!myCourseIds.includes(g.courseId)) return res.status(403).json({ error: 'Not your course' });
  if (!Array.isArray(g.joiners)) g.joiners = [];
  if (!g.joiners.some(j => j.studentId === me.id)) {
    g.joiners.push({ studentId: me.id, studentName: me.name });
    const host = DB.students.find(s => s.id === g.hostId);
    if (host?.userId && host.id !== me.id) notify(host.userId, 'Someone joined your session ✅', `${me.name} joined "${g.topic}".`, 'group_session');
    saveDB();
  }
  res.json(shapeGroupSession(g, me));
});
app.post('/api/group-sessions/:id/leave', auth, (req, res) => {
  const me = DB.students.find(s => s.userId === req.user.id);
  if (!me) return res.status(403).json({ error: 'Students only' });
  const g = (DB.group_sessions || []).find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  g.joiners = (g.joiners || []).filter(j => j.studentId !== me.id);
  saveDB();
  res.json(shapeGroupSession(g, me));
});
app.delete('/api/group-sessions/:id', auth, (req, res) => {
  const g = (DB.group_sessions || []).find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const me = DB.students.find(s => s.userId === req.user.id);
  const isHost = me && g.hostId === me.id;
  if (!isHost && !canModerateSession(req, g)) return res.status(403).json({ error: 'Only the host or admin can remove this' });
  DB.group_sessions = (DB.group_sessions || []).filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

// ── LESSON VIDEOS (admin adds recorded-video links; can enable/disable each) ───
function canEditVideoCourse(req, courseId) {
  if (req.user.role === 'superadmin') return true;
  if (req.user.role === 'admin') { const a = getAdminRecord(req.user.id); return !!a && adminCourseIds(a.id).includes(Number(courseId)); }
  return false;
}
// List videos. Students: only VISIBLE videos for courses they're enrolled in.
// Admin/super: all videos (incl. hidden) for their courses, so they can manage.
app.get('/api/lesson-videos', auth, (req, res) => {
  const all = DB.lesson_videos || [];
  const sortV = (a, b) => (a.order == null ? Infinity : a.order) - (b.order == null ? Infinity : b.order)
    || String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true })
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  if (req.user.role === 'admin' || req.user.role === 'superadmin') {
    let list = all;
    if (req.user.role === 'admin') { const a = getAdminRecord(req.user.id); const ids = adminCourseIds(a?.id); list = all.filter(v => ids.includes(Number(v.courseId))); }
    if (req.query.courseId) list = list.filter(v => Number(v.courseId) === Number(req.query.courseId));
    return res.json(list.slice().sort(sortV));
  }
  const student = DB.students.find(s => s.userId === req.user.id);
  if (!student) return res.json([]);
  const enrolled = DB.enrollments.filter(e => e.studentId === student.id).map(e => e.courseId);
  let list = all.filter(v => v.visible !== false && enrolled.includes(Number(v.courseId)));
  if (req.query.courseId) list = list.filter(v => Number(v.courseId) === Number(req.query.courseId));
  res.json(list.slice().sort(sortV));
});
app.post('/api/lesson-videos', auth, adminOrSuper, (req, res) => {
  const { courseId, moduleIndex, title, description, videoUrl, visible, order, fileData } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
  if (!fileData && (!videoUrl || !String(videoUrl).trim())) return res.status(400).json({ error: 'Add a video link or upload a file' });
  if (!courseId) return res.status(400).json({ error: 'Course is required' });
  if (!canEditVideoCourse(req, courseId)) return res.status(403).json({ error: 'Not your course' });
  if (fileData && fileData.length > 75_000_000) return res.status(413).json({ error: 'Video too large (max ~50MB). Use a YouTube/Drive link for bigger videos.' });
  if (!Array.isArray(DB.lesson_videos)) DB.lesson_videos = [];
  const adminRec = req.user.role === 'admin' ? getAdminRecord(req.user.id) : null;
  const id = uuidv4();
  let finalUrl = String(videoUrl || '').slice(0, 1000);
  if (fileData) { const saved = saveVideoFile(id, fileData); if (!saved) return res.status(400).json({ error: 'Could not read the video file' }); finalUrl = saved; }
  const v = {
    id, courseId: Number(courseId),
    moduleIndex: (moduleIndex === undefined || moduleIndex === null || moduleIndex === '') ? null : Number(moduleIndex),
    title: String(title).slice(0, 200), description: String(description || '').slice(0, 500),
    videoUrl: finalUrl,
    visible: visible === undefined ? true : !!visible,
    order: (order === undefined || order === null || order === '') ? null : Number(order),
    adminId: adminRec?.id || null, adminName: req.user.name, createdAt: new Date().toISOString(),
  };
  DB.lesson_videos.push(v);
  saveDB();
  res.status(201).json(v);
});
app.put('/api/lesson-videos/:id', auth, adminOrSuper, (req, res) => {
  const idx = (DB.lesson_videos || []).findIndex(v => v.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const cur = DB.lesson_videos[idx];
  if (!canEditVideoCourse(req, cur.courseId)) return res.status(403).json({ error: 'Not your course' });
  const { title, description, videoUrl, moduleIndex, visible, order, courseId, fileData } = req.body;
  if (courseId !== undefined && !canEditVideoCourse(req, courseId)) return res.status(403).json({ error: 'Not your course' });
  if (fileData && fileData.length > 75_000_000) return res.status(413).json({ error: 'Video too large (max ~50MB).' });
  let nextUrl = videoUrl !== undefined ? String(videoUrl).slice(0, 1000) : cur.videoUrl;
  if (fileData) { const saved = saveVideoFile(cur.id, fileData); if (saved) { deleteVideoFile(cur.videoUrl !== saved ? cur.videoUrl : null); nextUrl = saved; } }
  DB.lesson_videos[idx] = {
    ...cur,
    title: title !== undefined ? String(title).slice(0, 200) : cur.title,
    description: description !== undefined ? String(description).slice(0, 500) : cur.description,
    videoUrl: nextUrl,
    courseId: courseId !== undefined ? Number(courseId) : cur.courseId,
    moduleIndex: moduleIndex !== undefined ? (moduleIndex === '' || moduleIndex === null ? null : Number(moduleIndex)) : cur.moduleIndex,
    visible: visible !== undefined ? !!visible : cur.visible,
    order: order !== undefined ? (order === '' || order === null ? null : Number(order)) : cur.order,
  };
  saveDB();
  res.json(DB.lesson_videos[idx]);
});
// Quick enable/disable toggle.
app.post('/api/lesson-videos/:id/toggle', auth, adminOrSuper, (req, res) => {
  const v = (DB.lesson_videos || []).find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (!canEditVideoCourse(req, v.courseId)) return res.status(403).json({ error: 'Not your course' });
  v.visible = v.visible === false ? true : false;
  saveDB();
  res.json(v);
});
app.delete('/api/lesson-videos/:id', auth, adminOrSuper, (req, res) => {
  const v = (DB.lesson_videos || []).find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (!canEditVideoCourse(req, v.courseId)) return res.status(403).json({ error: 'Not your course' });
  deleteVideoFile(v.videoUrl); // remove the uploaded file from disk, if any
  DB.lesson_videos = (DB.lesson_videos || []).filter(x => x.id !== req.params.id);
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
// Best-effort: open the Windows Firewall for our port so other devices on the
// LAN/Wi-Fi can connect. Silently no-ops if not on Windows or not elevated
// (in that case, run Allow-Firewall-Once.bat as administrator instead).
function ensureFirewallOpen() {
  if (process.platform !== 'win32') return;
  try {
    const { exec } = require('child_process');
    const ruleName = 'DhishaAI LMS ' + PORT;
    exec(`netsh advfirewall firewall show rule name="${ruleName}"`, (_e, stdout) => {
      if (stdout && stdout.includes(ruleName)) return; // rule already exists
      exec(`netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${PORT} profile=any`,
        (e2) => {
          if (e2) console.log(`⚠  Could not auto-open the firewall — run Allow-Firewall-Once.bat as administrator so other devices can connect.`);
          else console.log(`🛡  Firewall: opened TCP ${PORT} for LAN/Wi-Fi access.`);
        });
    });
  } catch { /* ignore */ }
}

// Find this machine's LAN (Wi-Fi/Ethernet) IPv4 so others on the same network
// can be told exactly which address to open.
function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) out.push(net.address);
    }
  }
  return out;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 DhishaAI Enterprise LMS v5.0`);
  console.log(`\n✅ On this PC:        http://localhost:${PORT}`);
  const ips = lanIPs();
  if (ips.length) {
    console.log(`\n📶 On the same Wi-Fi (share these with your users):`);
    ips.forEach(ip => console.log(`   → http://${ip}:${PORT}`));
    console.log(`   (If it doesn't open on other devices, allow TCP port ${PORT} through Windows Firewall.)`);
  }
  ensureFirewallOpen(); // best-effort: open the firewall so LAN/Wi-Fi devices can connect
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
