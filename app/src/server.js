import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';
import mysql2 from 'mysql2';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import morgan from 'morgan';
import { fileTypeFromBuffer } from 'file-type';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, unlink, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const ENABLE_TEST_ERROR_ENDPOINT = process.env.ENABLE_TEST_ERROR_ENDPOINT === 'true';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../uploads'));
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, '../logs'));
const LOG_FILE = path.join(LOG_DIR, 'gallery-access.log');
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);
const scryptAsync = promisify(scrypt);

if (!ADMIN_USER || !ADMIN_PASSWORD || SESSION_SECRET.length < 32) {
  throw new Error('Set ADMIN_USER, ADMIN_PASSWORD and SESSION_SECRET (at least 32 characters) in .env.');
}
if (ADMIN_USER.length > 120) {
  throw new Error('ADMIN_USER must not exceed 120 characters.');
}

await mkdir(UPLOAD_DIR, { recursive: true });
await mkdir(LOG_DIR, { recursive: true });

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'gallery_user',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'gallery_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
};
const pool = mysql.createPool(dbConfig);
// express-mysql-session uses the callback-style mysql2 pool, not mysql2/promise.
const sessionPool = mysql2.createPool(dbConfig);
const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: 24 * 60 * 60 * 1000,
  createDatabaseTable: true,
  schema: { tableName: 'sessions', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } }
}, sessionPool);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(session({
  name: 'gallery.sid',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'gallery_' });
const requestsTotal = new Counter({
  name: 'gallery_http_requests_total',
  help: 'Total HTTP requests received by the Gallery application.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry]
});
const requestDuration = new Histogram({
  name: 'gallery_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry]
});

function logLine(level, message, extra = {}) {
  const record = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...extra }) + '\n';
  process.stdout.write(record);
  // Append-only application log for Grafana Alloy. Never log passwords or session contents.
  appendFile(path.join(LOG_DIR, 'gallery-app.log'), record).catch(() => {});
}

app.use(morgan('combined', {
  skip: (req) => req.path.startsWith('/api/share/') || req.path.startsWith('/api/photo-share/') || req.path.startsWith('/share/') || req.path.startsWith('/photo/'),
  stream: {
    write(message) {
      process.stdout.write(message);
      appendFile(LOG_FILE, message).catch(() => {});
    }
  }
}));
app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path.replace(/[0-9a-f]{16,}/gi, ':token').replace(/\d+/g, ':id');
    const labels = { method: req.method, route: route || '/', status_code: String(res.statusCode) };
    requestsTotal.inc(labels);
    requestDuration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
  });
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Quá nhiều lần đăng nhập. Hãy thử lại sau 15 phút.' }
});

function hashForCompare(value) {
  return createHash('sha256').update(String(value ?? '')).digest();
}
function safeEqual(a, b) {
  return timingSafeEqual(hashForCompare(a), hashForCompare(b));
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, hashHex] = String(storedHash || '').split('$');
  if (algorithm !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Bạn cần đăng nhập để sử dụng chức năng này.' });
}
function validateText(value, maxLength, field) {
  if (typeof value !== 'string') throw Object.assign(new Error(`${field} không hợp lệ.`), { status: 400 });
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw Object.assign(new Error(`${field} không được vượt quá ${maxLength} ký tự.`), { status: 400 });
  return trimmed;
}
function positiveId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw Object.assign(new Error('ID không hợp lệ.'), { status: 400 });
  return number;
}
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const supplied = req.get('x-csrf-token');
  if (!req.session?.csrfToken || !supplied || !safeEqual(supplied, req.session.csrfToken)) {
    return res.status(403).json({ error: 'CSRF token không hợp lệ. Tải lại trang rồi thử lại.' });
  }
  next();
}
app.use(csrfGuard);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 5, fields: 5 },
  fileFilter: (_req, file, callback) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    if (!supported.has(ext) || ![...ALLOWED_IMAGES.keys()].includes(mime)) {
      return callback(Object.assign(new Error('Chỉ chấp nhận ảnh JPG, PNG, WEBP hoặc GIF.'), { status: 415 }));
    }
    callback(null, true);
  }
});

async function ensureApplicationSchema() {
  const [columns] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'photos' AND COLUMN_NAME = 'category'`,
    [dbConfig.database]
  );
  if (!columns.length) {
    await pool.execute("ALTER TABLE photos ADD COLUMN category VARCHAR(60) NOT NULL DEFAULT 'Khác' AFTER size_bytes");
  }
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS photo_shares (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      photo_id BIGINT UNSIGNED NOT NULL,
      token CHAR(64) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_photo_shares_photo (photo_id),
      UNIQUE KEY uq_photo_shares_token (token),
      CONSTRAINT fk_shares_photo FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(120) NOT NULL,
      password_hash VARCHAR(180) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  const [passwordHashColumns] = await pool.execute(
    `SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_hash'`,
    [dbConfig.database]
  );
  if (passwordHashColumns[0]?.CHARACTER_MAXIMUM_LENGTH < 168) {
    await pool.execute('ALTER TABLE users MODIFY password_hash VARCHAR(180) NOT NULL');
  }
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id VARCHAR(128) NOT NULL,
      expires INT UNSIGNED NOT NULL,
      data MEDIUMTEXT NOT NULL,
      user_id BIGINT UNSIGNED NULL,
      PRIMARY KEY (session_id),
      INDEX idx_sessions_expires (expires),
      INDEX idx_sessions_user_id (user_id),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const [sessionColumns] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'user_id'`,
    [dbConfig.database]
  );
  if (!sessionColumns.length) {
    await pool.execute('ALTER TABLE sessions ADD COLUMN user_id BIGINT UNSIGNED NULL');
  }

  const [sessionIndexes] = await pool.execute(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sessions' AND INDEX_NAME = 'idx_sessions_user_id'`,
    [dbConfig.database]
  );
  if (!sessionIndexes.length) {
    await pool.execute('ALTER TABLE sessions ADD INDEX idx_sessions_user_id (user_id)');
  }

  const [sessionConstraints] = await pool.execute(
    `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'sessions' AND CONSTRAINT_NAME = 'fk_sessions_user'`,
    [dbConfig.database]
  );
  if (!sessionConstraints.length) {
    await pool.execute(
      'ALTER TABLE sessions ADD CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'
    );
  }

  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await pool.execute(
    `INSERT INTO users (username, password_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [ADMIN_USER, passwordHash]
  );
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unavailable' });
  }
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.get('/api/csrf', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
  res.set('Cache-Control', 'no-store');
  res.json({ csrfToken: req.session.csrfToken });
});

app.get('/api/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ authenticated: Boolean(req.session.user), username: req.session.user?.username || null });
});

app.post('/api/login', loginLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const [users] = await pool.execute(
      'SELECT id, username, password_hash FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    const user = users[0];
    if (!user || !await verifyPassword(password, user.password_hash)) {
      logLine('warn', 'Login attempt rejected', { ip: req.ip });
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    }
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.user = { id: user.id, username: user.username };
      req.session.csrfToken = randomBytes(32).toString('hex');
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        pool.execute('UPDATE sessions SET user_id = ? WHERE session_id = ?', [user.id, req.sessionID])
          .then(([result]) => {
            if (!result.affectedRows) throw new Error('Could not associate the login session with its user.');
            logLine('info', 'Admin login successful', { username: user.username, ip: req.ip });
            res.json({ authenticated: true, username: user.username, csrfToken: req.session.csrfToken });
          })
          .catch((associationError) => {
            req.session.destroy((destroyError) => {
              if (destroyError) logLine('error', 'Failed to destroy unassociated login session', { username: user.username });
              next(associationError);
            });
          });
      });
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('gallery.sid', { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE });
    res.json({ ok: true });
  });
});

if (ENABLE_TEST_ERROR_ENDPOINT) {
  app.post('/api/test/500', requireAuth, (_req, _res, next) => {
    next(Object.assign(new Error('Controlled test error for 5xx monitoring.'), { status: 500 }));
  });
}

app.use('/api/albums', requireAuth);

app.get('/api/albums', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.id, a.name, a.description, a.category, a.created_at,
             COUNT(p.id) AS photo_count,
             COALESCE((SELECT s.enabled FROM album_shares s WHERE s.album_id = a.id LIMIT 1), 0) AS share_enabled
      FROM albums a LEFT JOIN photos p ON p.album_id = a.id
      GROUP BY a.id ORDER BY a.created_at DESC
    `);
    res.json({ albums: rows });
  } catch (error) { next(error); }
});

app.post('/api/albums', async (req, res, next) => {
  try {
    const name = validateText(req.body?.name, 120, 'Tên album');
    const description = validateText(req.body?.description ?? '', 1000, 'Mô tả');
    const category = validateText(req.body?.category || 'Khác', 60, 'Phân loại') || 'Khác';
    if (!name) return res.status(400).json({ error: 'Tên album không được để trống.' });
    const [result] = await pool.execute('INSERT INTO albums (name, description, category) VALUES (?, ?, ?)', [name, description || null, category]);
    res.status(201).json({ album: { id: result.insertId, name, description, category, photo_count: 0 } });
  } catch (error) { next(error); }
});

app.patch('/api/albums/:id', async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    const name = validateText(req.body?.name, 120, 'Tên album');
    const description = validateText(req.body?.description ?? '', 1000, 'Mô tả');
    const category = validateText(req.body?.category || 'Khác', 60, 'Phân loại') || 'Khác';
    if (!name) return res.status(400).json({ error: 'Tên album không được để trống.' });
    const [albums] = await pool.execute('SELECT id FROM albums WHERE id = ?', [id]);
    if (!albums.length) return res.status(404).json({ error: 'Không tìm thấy album.' });
    await pool.execute(
      'UPDATE albums SET name = ?, description = ?, category = ? WHERE id = ?',
      [name, description || null, category, id]
    );
    res.json({ album: { id, name, description, category } });
  } catch (error) { next(error); }
});

app.patch('/api/albums/:id/category', async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    const category = validateText(req.body?.category, 60, 'Phân loại');
    if (!category) return res.status(400).json({ error: 'Phân loại không được để trống.' });
    const [albums] = await pool.execute('SELECT id FROM albums WHERE id = ?', [id]);
    if (!albums.length) return res.status(404).json({ error: 'Không tìm thấy album.' });
    await pool.execute('UPDATE albums SET category = ? WHERE id = ?', [category, id]);
    res.json({ album: { id, category } });
  } catch (error) { next(error); }
});

app.delete('/api/albums/:id', async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    const [photos] = await pool.execute('SELECT filename FROM photos WHERE album_id = ?', [id]);
    const [result] = await pool.execute('DELETE FROM albums WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Không tìm thấy album.' });
    await Promise.all(photos.map((photo) => unlink(path.join(UPLOAD_DIR, photo.filename)).catch(() => {})));
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/albums/:id/photos', async (req, res, next) => {
  try {
    const albumId = positiveId(req.params.id);
    const [rows] = await pool.execute(
      `SELECT p.id, p.album_id, p.filename, p.original_name, p.mime_type, p.size_bytes,
              p.category, p.created_at,
              COALESCE((SELECT s.enabled FROM photo_shares s WHERE s.photo_id = p.id LIMIT 1), 0) AS share_enabled
       FROM photos p WHERE p.album_id = ? ORDER BY p.created_at DESC`,
      [albumId]
    );
    res.json({ photos: rows.map((photo) => ({ ...photo, url: `/media/${encodeURIComponent(photo.filename)}` })) });
  } catch (error) { next(error); }
});

app.post('/api/albums/:id/photos', upload.array('photos', 5), async (req, res, next) => {
  const savedPaths = [];
  let connection;
  try {
    const albumId = positiveId(req.params.id);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Bạn chưa chọn ảnh.' });
    const [albums] = await pool.execute('SELECT id FROM albums WHERE id = ?', [albumId]);
    if (!albums.length) return res.status(404).json({ error: 'Không tìm thấy album.' });
    const category = validateText(req.body?.category || 'Khác', 60, 'Phân loại') || 'Khác';
    const validatedFiles = [];
    for (const file of files) {
      const detected = await fileTypeFromBuffer(file.buffer);
      if (!detected || !ALLOWED_IMAGES.has(detected.mime)) {
        return res.status(415).json({ error: `Nội dung file "${path.basename(file.originalname)}" không phải định dạng ảnh được hỗ trợ.` });
      }
      validatedFiles.push({ file, mime: detected.mime, extension: ALLOWED_IMAGES.get(detected.mime) });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const photos = [];
    for (const { file, mime, extension } of validatedFiles) {
      const filename = `${randomUUID()}.${extension}`;
      const savedPath = path.join(UPLOAD_DIR, filename);
      await writeFile(savedPath, file.buffer, { flag: 'wx', mode: 0o640 });
      savedPaths.push(savedPath);
      const originalName = path.basename(file.originalname).slice(0, 255);
      const [result] = await connection.execute(
        'INSERT INTO photos (album_id, filename, original_name, mime_type, size_bytes, category) VALUES (?, ?, ?, ?, ?, ?)',
        [albumId, filename, originalName, mime, file.size, category]
      );
      photos.push({ id: result.insertId, album_id: albumId, filename, original_name: originalName, mime_type: mime, size_bytes: file.size, category, url: `/media/${encodeURIComponent(filename)}` });
    }
    await connection.commit();
    res.status(201).json({ photos });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    await Promise.all(savedPaths.map((savedPath) => unlink(savedPath).catch(() => {})));
    next(error);
  } finally {
    connection?.release();
  }
});

app.get('/api/photos', requireAuth, async (_req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.id, p.album_id, a.name AS album_name, p.filename, p.original_name,
             p.mime_type, p.size_bytes, p.category, p.created_at,
             COALESCE((SELECT s.enabled FROM photo_shares s WHERE s.photo_id = p.id LIMIT 1), 0) AS share_enabled
      FROM photos p JOIN albums a ON a.id = p.album_id
      ORDER BY p.created_at DESC
    `);
    res.json({ photos: rows.map((photo) => ({ ...photo, url: `/media/${encodeURIComponent(photo.filename)}` })) });
  } catch (error) { next(error); }
});

app.patch('/api/photos/:id/category', requireAuth, async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    const category = validateText(req.body?.category, 60, 'Phân loại');
    if (!category) return res.status(400).json({ error: 'Phân loại không được để trống.' });
    const [result] = await pool.execute('UPDATE photos SET category = ? WHERE id = ?', [category, id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Không tìm thấy ảnh.' });
    res.json({ photo: { id, category } });
  } catch (error) { next(error); }
});

app.delete('/api/photos/:id', requireAuth, async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    const [rows] = await pool.execute('SELECT filename FROM photos WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy ảnh.' });
    await pool.execute('DELETE FROM photos WHERE id = ?', [id]);
    await unlink(path.join(UPLOAD_DIR, rows[0].filename)).catch(() => {});
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/photos/:id/share', requireAuth, async (req, res, next) => {
  try {
    const photoId = positiveId(req.params.id);
    const [photos] = await pool.execute('SELECT id FROM photos WHERE id = ?', [photoId]);
    if (!photos.length) return res.status(404).json({ error: 'Không tìm thấy ảnh.' });
    const token = randomBytes(32).toString('hex');
    await pool.execute(
      `INSERT INTO photo_shares (photo_id, token, enabled) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE token = VALUES(token), enabled = 1, created_at = CURRENT_TIMESTAMP`,
      [photoId, token]
    );
    res.status(201).json({ sharePath: `/photo/${token}` });
  } catch (error) { next(error); }
});

app.delete('/api/photos/:id/share', requireAuth, async (req, res, next) => {
  try {
    const photoId = positiveId(req.params.id);
    const [result] = await pool.execute('UPDATE photo_shares SET enabled = 0 WHERE photo_id = ?', [photoId]);
    res.json({ ok: true, revoked: result.affectedRows > 0 });
  } catch (error) { next(error); }
});

app.get('/api/photo-share/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: 'Liên kết chia sẻ không hợp lệ hoặc đã bị thu hồi.' });
    const [photos] = await pool.execute(
      `SELECT p.id, p.original_name, p.mime_type, p.size_bytes, p.category, p.created_at,
              a.name AS album_name, p.filename
       FROM photos p JOIN photo_shares s ON s.photo_id = p.id
       JOIN albums a ON a.id = p.album_id
       WHERE s.token = ? AND s.enabled = 1 LIMIT 1`, [token]
    );
    if (!photos.length) return res.status(404).json({ error: 'Liên kết chia sẻ không hợp lệ hoặc đã bị thu hồi.' });
    const photo = photos[0];
    res.set('Cache-Control', 'no-store');
    res.json({ photo: { ...photo, url: `/media/${encodeURIComponent(photo.filename)}` } });
  } catch (error) { next(error); }
});

app.post('/api/albums/:id/share', async (req, res, next) => {
  try {
    const albumId = positiveId(req.params.id);
    const [albums] = await pool.execute('SELECT id FROM albums WHERE id = ?', [albumId]);
    if (!albums.length) return res.status(404).json({ error: 'Không tìm thấy album.' });
    const token = randomBytes(32).toString('hex');
    await pool.execute(
      `INSERT INTO album_shares (album_id, token, enabled) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE token = VALUES(token), enabled = 1, created_at = CURRENT_TIMESTAMP`,
      [albumId, token]
    );
    res.status(201).json({ sharePath: `/share/${token}` });
  } catch (error) { next(error); }
});

app.delete('/api/albums/:id/share', async (req, res, next) => {
  try {
    const albumId = positiveId(req.params.id);
    const [result] = await pool.execute('UPDATE album_shares SET enabled = 0 WHERE album_id = ?', [albumId]);
    res.json({ ok: true, revoked: result.affectedRows > 0 });
  } catch (error) { next(error); }
});

app.get('/api/share/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: 'Liên kết chia sẻ không hợp lệ hoặc đã bị thu hồi.' });
    const [albums] = await pool.execute(
      `SELECT a.id, a.name, a.description, a.category, a.created_at
       FROM albums a JOIN album_shares s ON s.album_id = a.id
       WHERE s.token = ? AND s.enabled = 1 LIMIT 1`, [token]
    );
    if (!albums.length) return res.status(404).json({ error: 'Liên kết chia sẻ không hợp lệ hoặc đã bị thu hồi.' });
    const [photos] = await pool.execute(
      'SELECT id, filename, original_name, mime_type, size_bytes, created_at FROM photos WHERE album_id = ? ORDER BY created_at DESC',
      [albums[0].id]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ album: albums[0], photos: photos.map((photo) => ({ ...photo, url: `/media/${encodeURIComponent(photo.filename)}` })) });
  } catch (error) { next(error); }
});

app.get('/media/:filename', async (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename);
    const [rows] = await pool.execute(
      `SELECT p.filename, p.mime_type
       FROM photos p
       LEFT JOIN album_shares s ON s.album_id = p.album_id AND s.enabled = 1
       LEFT JOIN photo_shares ps ON ps.photo_id = p.id AND ps.enabled = 1
       WHERE p.filename = ? AND (? = 1 OR s.id IS NOT NULL OR ps.id IS NOT NULL) LIMIT 1`,
      [filename, req.session.user ? 1 : 0]
    );
    if (!rows.length) return res.sendStatus(404);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=3600');
    res.type(rows[0].mime_type);
    res.sendFile(path.join(UPLOAD_DIR, rows[0].filename));
  } catch (error) { next(error); }
});

app.get('/share/:token', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/photo/:token', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.use(express.static(path.join(__dirname, '../public'), {
  index: 'index.html',
  maxAge: '1h',
  dotfiles: 'deny',
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

app.use((err, req, res, _next) => {
  const status = Number(err.status || (err instanceof multer.MulterError ? 400 : 500));
  logLine(status >= 500 ? 'error' : 'warn', err.message || 'Request failed', { status, method: req.method, path: req.path });
  if (res.headersSent) return;
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Ảnh vượt quá giới hạn 10 MB.' });
  }
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Mỗi lần chỉ có thể tải lên tối đa 5 ảnh.' });
  }
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: status >= 500 ? 'Máy chủ gặp lỗi. Hãy thử lại sau.' : (err.message || 'Yêu cầu không hợp lệ.')
  });
});

await ensureApplicationSchema();
const server = app.listen(PORT, '0.0.0.0', () => logLine('info', `Gallery server listening on ${PORT}`));

async function shutdown(signal) {
  logLine('info', `Received ${signal}, shutting down`);
  server.close(async () => {
    try { if (typeof sessionStore.close === 'function') await sessionStore.close(); } catch {}
    try { await new Promise((resolve) => sessionPool.end(() => resolve())); } catch {}
    try { await pool.end(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
