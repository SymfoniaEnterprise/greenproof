import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from './db.js';
import { computeNet } from './net.js';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  isValidSession,
  readSessionToken,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3131);

const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo123';

const app = Fastify({ logger: false });

app.register(fastifyCookie);
app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  index: false,
});

// ---------- helpers ----------

function round2(x) {
  return Math.round(x * 100) / 100;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isValidMonth(month) {
  return typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function lastDayOfMonth(month) {
  const [year, m] = month.split('-').map(Number);
  const last = new Date(year, m, 0).getDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

function validateEmployee({ name, pesel, salary }) {
  if (typeof name !== 'string' || name.trim() === '') {
    return 'Imię i nazwisko jest wymagane';
  }
  if (typeof pesel !== 'string' || !/^\d{11}$/.test(pesel.trim())) {
    return 'PESEL musi mieć 11 cyfr';
  }
  const sal = Number(salary);
  if (!Number.isFinite(sal) || sal <= 0) {
    return 'Stawka musi być dodatnia';
  }
  return null;
}

function employeesHiredInMonth(month) {
  const lastDay = lastDayOfMonth(month);
  return db
    .prepare('SELECT * FROM employees WHERE hired_at <= ? ORDER BY name ASC')
    .all(lastDay);
}

function buildPayrollRows(month) {
  return db
    .prepare(
      `SELECT p.id, p.gross, p.net, e.name, e.pesel
       FROM payrolls p
       JOIN employees e ON e.id = p.employee_id
       WHERE p.month = ?
       ORDER BY e.name ASC`
    )
    .all(month);
}

function countAttempts(month) {
  return db
    .prepare('SELECT COUNT(*) AS c FROM payroll_attempts WHERE month = ?')
    .get(month).c;
}

function recordAttempt(month, status) {
  db.prepare(
    'INSERT INTO payroll_attempts (month, status, created_at) VALUES (?, ?, ?)'
  ).run(month, status, new Date().toISOString());
}

function clearDatabase() {
  db.prepare('DELETE FROM payrolls').run();
  db.prepare('DELETE FROM payroll_attempts').run();
  db.prepare('DELETE FROM employees').run();
  db.prepare('DELETE FROM sessions').run();
}

// ---------- auth guard ----------

function isAuthenticated(request) {
  return isValidSession(readSessionToken(request));
}

// ---------- page routes ----------

app.get('/', async (request, reply) => {
  if (isAuthenticated(request)) return reply.redirect('/employees');
  return reply.redirect('/login');
});

app.get('/login', async (request, reply) => {
  return reply.sendFile('login.html');
});

app.get('/employees', async (request, reply) => {
  if (!isAuthenticated(request)) return reply.redirect('/login');
  return reply.sendFile('employees.html');
});

app.get('/payroll', async (request, reply) => {
  if (!isAuthenticated(request)) return reply.redirect('/login');
  return reply.sendFile('payroll.html');
});

// Block direct access to protected HTML shells without a session.
app.addHook('onRequest', async (request, reply) => {
  const path = request.url.split('?')[0];
  if (
    (path === '/employees.html' || path === '/payroll.html') &&
    !isAuthenticated(request)
  ) {
    return reply.redirect('/login');
  }
});

// ---------- auth api ----------

app.post('/api/login', async (request, reply) => {
  const { username, password } = request.body || {};
  if (username === DEMO_USERNAME && password === DEMO_PASSWORD) {
    const token = createSession();
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
    return { ok: true };
  }
  return reply.code(401).send({ error: 'Nieprawidłowy login lub hasło' });
});

app.post('/api/logout', async (request, reply) => {
  destroySession(readSessionToken(request));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/session', async (request, reply) => {
  return { authenticated: isAuthenticated(request) };
});

// ---------- employees api ----------

app.get('/api/employees', async (request, reply) => {
  if (!isAuthenticated(request)) {
    return reply.code(401).send({ error: 'Nie jesteś zalogowany' });
  }
  const rows = db
    .prepare('SELECT id, name, pesel, salary, hired_at FROM employees ORDER BY id ASC')
    .all();
  return { employees: rows };
});

app.post('/api/employees', async (request, reply) => {
  if (!isAuthenticated(request)) {
    return reply.code(401).send({ error: 'Nie jesteś zalogowany' });
  }
  const { name, pesel, salary } = request.body || {};
  const error = validateEmployee({ name, pesel, salary });
  if (error) {
    return reply.code(400).send({ error });
  }
  const hiredAt = todayISO();
  const info = db
    .prepare('INSERT INTO employees (name, pesel, salary, hired_at) VALUES (?, ?, ?, ?)')
    .run(name.trim(), pesel.trim(), Number(salary), hiredAt);
  const row = db
    .prepare('SELECT id, name, pesel, salary, hired_at FROM employees WHERE id = ?')
    .get(info.lastInsertRowid);
  return { employee: row };
});

// ---------- payroll api ----------

app.get('/api/payroll', async (request, reply) => {
  if (!isAuthenticated(request)) {
    return reply.code(401).send({ error: 'Nie jesteś zalogowany' });
  }
  const { month } = request.query;
  if (!month) {
    return reply.code(400).send({ error: 'Brak parametru month' });
  }
  const rows = buildPayrollRows(month);
  return { month, rows, count: rows.length };
});

app.post('/api/payroll', async (request, reply) => {
  if (!isAuthenticated(request)) {
    return reply.code(401).send({ error: 'Nie jesteś zalogowany' });
  }
  const { month } = request.body || {};
  if (!isValidMonth(month)) {
    return reply.code(400).send({ error: 'Miesiąc musi być w formacie YYYY-MM' });
  }

  const delay = 2000 + Math.floor(Math.random() * 6001);
  await new Promise((resolve) => setTimeout(resolve, delay));

  if (countAttempts(month) === 0 && Math.random() < 0.3) {
    recordAttempt(month, '503');
    return reply
      .code(503)
      .send({ error: 'Lista płac w przygotowaniu, spróbuj ponownie' });
  }

  const employees = employeesHiredInMonth(month);
  if (employees.length === 0) {
    return reply
      .code(422)
      .send({ error: `Brak pracowników zatrudnionych w miesiącu ${month}` });
  }

  recordAttempt(month, 'success');

  const insert = db.prepare(
    `INSERT OR IGNORE INTO payrolls (month, employee_id, gross, net, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  for (const emp of employees) {
    const { net } = computeNet(emp.salary);
    insert.run(month, emp.id, emp.salary, net, now);
  }

  const rows = buildPayrollRows(month);
  return { month, rows, count: rows.length };
});

// ---------- test api (no auth) ----------

app.post('/api/test/reset', async () => {
  clearDatabase();
  return { ok: true };
});

app.post('/api/test/seed', async (request, reply) => {
  const { employees = [], payrolls = [] } = request.body || {};
  if (!Array.isArray(employees) || !Array.isArray(payrolls)) {
    return reply
      .code(400)
      .send({ error: 'employees i payrolls muszą być tablicami' });
  }

  const insertEmployee = db.prepare(
    'INSERT INTO employees (name, pesel, salary, hired_at) VALUES (?, ?, ?, ?)'
  );

  const createdEmployees = [];
  for (const e of employees) {
    const name = String(e.name || '');
    const pesel = String(e.pesel || '');
    const salary = Number(e.salary);
    const hiredAt = String(e.hiredAt || todayISO()).slice(0, 10);
    const info = insertEmployee.run(name, pesel, salary, hiredAt);
    createdEmployees.push({
      id: Number(info.lastInsertRowid),
      name,
      pesel,
      salary,
      hired_at: hiredAt,
    });
  }

  const insertPayroll = db.prepare(
    `INSERT OR IGNORE INTO payrolls (month, employee_id, gross, net, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const createdPayrolls = [];

  for (const p of payrolls) {
    const month = String(p.month || '');
    if (!isValidMonth(month)) {
      return reply
        .code(400)
        .send({ error: `Nieprawidłowy miesiąc: ${month}` });
    }
    const hired = employeesHiredInMonth(month);
    if (hired.length === 0) {
      return reply
        .code(422)
        .send({ error: `Brak pracowników zatrudnionych w miesiącu ${month}` });
    }
    const rows = [];
    for (const emp of hired) {
      const { net } = computeNet(emp.salary);
      insertPayroll.run(month, emp.id, emp.salary, net, now);
      rows.push({
        employeeId: emp.id,
        name: emp.name,
        gross: emp.salary,
        net,
      });
    }
    createdPayrolls.push({ month, rows });
  }

  return {
    employees: createdEmployees,
    payrolls: createdPayrolls,
  };
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`DemoPay server listening on http://localhost:${PORT}`);
});
