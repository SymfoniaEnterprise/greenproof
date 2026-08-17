import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = process.env.DEMO_DB_PATH || join(DATA_DIR, 'demo.db');

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'accountant', 'employee')),
    active INTEGER NOT NULL DEFAULT 1
  );
  
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    cost_center TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pesel TEXT NOT NULL,
    salary REAL NOT NULL,
    department_id INTEGER NOT NULL,
    position TEXT NOT NULL,
    hired_at TEXT NOT NULL,
    terminated_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (department_id) REFERENCES departments(id)
  );
  
  CREATE TABLE IF NOT EXISTS payrolls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    employee_id INTEGER NOT NULL,
    gross REAL NOT NULL,
    net REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'paid')),
    version INTEGER NOT NULL DEFAULT 1,
    approved_by TEXT,
    approved_at TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    UNIQUE(month, employee_id)
  );
  
  CREATE TABLE IF NOT EXISTS payroll_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('vacation', 'sick', 'unpaid')),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
    reason TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
  
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    created_at TEXT NOT NULL
  );
`);

// Seed demo users if not exists
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  db.prepare('INSERT INTO users (username, password, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run('admin', 'admin123', 'Administrator', 'admin', 1);
  db.prepare('INSERT INTO users (username, password, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run('accountant', 'account123', 'Księgowy Test', 'accountant', 1);
  db.prepare('INSERT INTO users (username, password, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run('employee', 'employee123', 'Pracownik Test', 'employee', 1);
}
