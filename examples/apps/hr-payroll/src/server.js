import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { createSession, destroySession, getSessionUser, readSessionToken, SESSION_COOKIE } from './auth.js';
import { computeNet, validatePesel, isValidDateFormat, isValidMonthFormat } from './net.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = parseInt(process.env.DEMO_PORT || '3132');

const app = Fastify({ logger: false });

app.register(fastifyCookie);
app.register(fastifyStatic, { root: PUBLIC_DIR, index: false });

function isAuthenticated(request) {
  return isValidSession(readSessionToken(request));
}

function isValidSession(token) {
  if (!token) return false;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return false;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

function getCurrentUser(request) {
  const token = readSessionToken(request);
  if (!token) return null;
  return getSessionUser(token);
}

function requireAuth(request, reply) {
  const user = getCurrentUser(request);
  if (!user) {
    reply.code(401).send({ error: 'Brak sesji. Zaloguj się.' });
    return null;
  }
  if (!user.active) {
    reply.code(403).send({ error: 'Konto zablokowane' });
    return null;
  }
  return user;
}

function requireRole(request, reply, allowedRoles) {
  const user = requireAuth(request, reply);
  if (!user) return null;
  if (!allowedRoles.includes(user.role)) {
    reply.code(403).send({ error: 'Brak uprawnień do tej operacji' });
    return null;
  }
  return user;
}

function writeAudit(actorUsername, action, target, details) {
  db.prepare('INSERT INTO audit_log (actor_username, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)').run(
    actorUsername,
    action,
    target,
    details ? JSON.stringify(details) : null,
    new Date().toISOString()
  );
}

// Page routes
app.get('/login', async (request, reply) => {
  const user = getCurrentUser(request);
  if (user) {
    return reply.redirect('/dashboard');
  }
  return reply.sendFile('login.html');
});

app.get('/dashboard', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  return reply.sendFile('dashboard.html');
});

app.get('/employees', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  return reply.sendFile('employees.html');
});

app.get('/payroll', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  return reply.sendFile('payroll.html');
});

app.get('/leave', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  return reply.sendFile('leave.html');
});

app.get('/departments', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  if (user.role !== 'admin') {
    return reply.code(403).send({ error: 'Brak uprawnień do tej operacji' });
  }
  return reply.sendFile('departments.html');
});

// API Routes
app.post('/api/login', async (request, reply) => {
  const { username, password } = request.body || {};
  
  if (!username || !password) {
    return reply.code(400).send({ error: 'Podaj login i hasło' });
  }
  
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (!user) {
    return reply.code(401).send({ error: 'Nieprawidłowy login lub hasło' });
  }
  
  if (user.password !== password) {
    return reply.code(401).send({ error: 'Nieprawidłowy login lub hasło' });
  }
  
  if (!user.active) {
    return reply.code(403).send({ error: 'Konto zablokowane' });
  }
  
  const token = createSession(user.id);
  
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8
  });
  
  writeAudit(username, 'login', null, { ip: request.ip });
  
  return { success: true, username: user.username, role: user.role, full_name: user.full_name };
});

app.post('/api/logout', async (request, reply) => {
  const user = getCurrentUser(request);
  const token = readSessionToken(request);
  
  if (user) {
    writeAudit(user.username, 'logout', null, null);
  }
  
  destroySession(token);
  
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { success: true };
});

app.get('/api/session', async (request, reply) => {
  const user = getCurrentUser(request);
  if (!user) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    username: user.username,
    role: user.role,
    full_name: user.full_name
  };
});

// Employees API
app.get('/api/employees', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  
  const {
    page = '1',
    pageSize = '10',
    sortBy = 'name',
    sortDir = 'ASC',
    departmentId,
    active,
    search
  } = request.query;
  
  let pageNum = parseInt(page);
  let size = Math.min(parseInt(pageSize), 50);
  if (pageNum < 1) pageNum = 1;
  if (size < 1) size = 10;
  
  const allowedSortFields = ['name', 'pesel', 'salary', 'department_id', 'hired_at'];
  const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'name';
  const sortDirection = sortDir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  
  let whereConditions = [];
  let params = [];
  
  if (departmentId) {
    whereConditions.push('e.department_id = ?');
    params.push(parseInt(departmentId));
  }
  
  if (active !== undefined && active !== null && active !== '') {
    whereConditions.push('e.active = ?');
    params.push(active === 'true' || active === '1' ? 1 : 0);
  }
  
  if (search) {
    whereConditions.push('e.name LIKE ?');
    params.push(`%${search}%`);
  }
  
  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
  
  const countResult = db.prepare(`
    SELECT COUNT(*) as total FROM employees e ${whereClause}
  `).get(...params);
  
  const offset = (pageNum - 1) * size;
  
  const employees = db.prepare(`
    SELECT e.*, d.name as department_name, d.cost_center
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    ${whereClause}
    ORDER BY ${sortField} ${sortDirection}
    LIMIT ? OFFSET ?
  `).all(...params, size, offset);
  
  return {
    employees,
    total: countResult.total,
    page: pageNum,
    pageSize: size
  };
});

app.post('/api/employees', async (request, reply) => {
  const user = requireRole(request, reply, ['admin']);
  if (!user) return;
  
  const { name, pesel, salary, department_id, position, hired_at } = request.body || {};
  
  if (!name || name.trim() === '') {
    return reply.code(400).send({ error: 'Imię i nazwisko jest wymagane' });
  }
  
  if (!validatePesel(pesel)) {
    return reply.code(400).send({ error: 'Nieprawidłowy numer PESEL' });
  }
  
  const existingPesel = db.prepare('SELECT id FROM employees WHERE pesel = ?').get(pesel);
  if (existingPesel) {
    return reply.code(409).send({ error: 'PESEL już istnieje' });
  }
  
  const salaryNum = parseFloat(salary);
  if (isNaN(salaryNum) || salaryNum <= 0 || salaryNum > 1000000) {
    return reply.code(400).send({ error: 'Wynagrodzenie musi być > 0 i <= 1000000' });
  }
  
  if (!department_id) {
    return reply.code(400).send({ error: 'ID działu jest wymagane' });
  }
  
  const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
  if (!dept) {
    return reply.code(400).send({ error: 'Dział o podanym ID nie istnieje' });
  }
  
  if (!position || position.trim() === '') {
    return reply.code(400).send({ error: 'Stanowisko jest wymagane' });
  }
  
  if (!isValidDateFormat(hired_at)) {
    return reply.code(400).send({ error: 'Data zatrudnienia musi być w formacie YYYY-MM-DD' });
  }
  
  const result = db.prepare(`
    INSERT INTO employees (name, pesel, salary, department_id, position, hired_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(name.trim(), pesel, salaryNum, department_id, position.trim(), hired_at);
  
  const newEmployee = db.prepare('SELECT * FROM employees WHERE id = ?').get(result.lastInsertRowid);
  
  writeAudit(user.username, 'create_employee', `employee:${newEmployee.id}`, { name, pesel, salary: salaryNum, department_id, position });
  
  return { success: true, employee: newEmployee };
});

app.put('/api/employees/:id', async (request, reply) => {
  const user = requireRole(request, reply, ['admin']);
  if (!user) return;
  
  const employeeId = parseInt(request.params.id);
  const { name, pesel, salary, department_id, position, hired_at, version } = request.body || {};
  
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) {
    return reply.code(404).send({ error: 'Pracownik nie istnieje' });
  }
  
  if (version !== undefined && employee.version !== version) {
    return reply.code(409).send({ error: 'Ktoś zmodyfikował ten rekord' });
  }
  
  if (name !== undefined && name.trim() === '') {
    return reply.code(400).send({ error: 'Imię i nazwisko jest wymagane' });
  }
  
  if (pesel !== undefined && !validatePesel(pesel)) {
    return reply.code(400).send({ error: 'Nieprawidłowy numer PESEL' });
  }
  
  if (pesel !== undefined && pesel !== employee.pesel) {
    const existingPesel = db.prepare('SELECT id FROM employees WHERE pesel = ? AND id != ?').get(pesel, employeeId);
    if (existingPesel) {
      return reply.code(409).send({ error: 'PESEL już istnieje' });
    }
  }
  
  if (salary !== undefined) {
    const salaryNum = parseFloat(salary);
    if (isNaN(salaryNum) || salaryNum <= 0 || salaryNum > 1000000) {
      return reply.code(400).send({ error: 'Wynagrodzenie musi być > 0 i <= 1000000' });
    }
  }
  
  if (department_id !== undefined) {
    const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
    if (!dept) {
      return reply.code(400).send({ error: 'Dział o podanym ID nie istnieje' });
    }
  }
  
  if (position !== undefined && position.trim() === '') {
    return reply.code(400).send({ error: 'Stanowisko jest wymagane' });
  }
  
  if (hired_at !== undefined && !isValidDateFormat(hired_at)) {
    return reply.code(400).send({ error: 'Data zatrudnienia musi być w formacie YYYY-MM-DD' });
  }
  
  const newVersion = (employee.version || 1) + 1;
  
  db.prepare(`
    UPDATE employees SET
      name = COALESCE(?, name),
      pesel = COALESCE(?, pesel),
      salary = COALESCE(?, salary),
      department_id = COALESCE(?, department_id),
      position = COALESCE(?, position),
      hired_at = COALESCE(?, hired_at),
      version = ?
    WHERE id = ?
  `).run(
    name ? name.trim() : null,
    pesel || null,
    salary ? parseFloat(salary) : null,
    department_id || null,
    position ? position.trim() : null,
    hired_at || null,
    newVersion,
    employeeId
  );
  
  const updatedEmployee = db.prepare(`
    SELECT e.*, d.name as department_name, d.cost_center
    FROM employees e
    LEFT JOIN departments d ON e.department_id = d.id
    WHERE e.id = ?
  `).get(employeeId);
  
  writeAudit(user.username, 'update_employee', `employee:${employeeId}`, { name, pesel, salary, department_id, position });
  
  return { success: true, employee: updatedEmployee };
});

app.post('/api/employees/:id/terminate', async (request, reply) => {
  const user = requireRole(request, reply, ['admin']);
  if (!user) return;
  
  const employeeId = parseInt(request.params.id);
  
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) {
    return reply.code(404).send({ error: 'Pracownik nie istnieje' });
  }
  
  const pendingPayrolls = db.prepare(`
    SELECT id FROM payrolls WHERE employee_id = ? AND status IN ('draft', 'approved')
  `).all(employeeId);
  
  if (pendingPayrolls.length > 0) {
    return reply.code(422).send({ error: 'Nie można zwolnić pracownika z niezakończonymi listami płac' });
  }
  
  const terminatedAt = new Date().toISOString().split('T')[0];
  
  db.prepare(`
    UPDATE employees SET terminated_at = ?, active = 0 WHERE id = ?
  `).run(terminatedAt, employeeId);
  
  writeAudit(user.username, 'terminate_employee', `employee:${employeeId}`, { terminated_at: terminatedAt });
  
  const updatedEmployee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  return { success: true, employee: updatedEmployee };
});

app.delete('/api/employees/:id', async (request, reply) => {
  const user = requireRole(request, reply, ['admin']);
  if (!user) return;
  
  const employeeId = parseInt(request.params.id);
  
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) {
    return reply.code(404).send({ error: 'Pracownik nie istnieje' });
  }
  
  const payrolls = db.prepare(`
    SELECT id FROM payrolls WHERE employee_id = ? AND status IN ('draft', 'approved', 'paid')
  `).all(employeeId);
  
  if (payrolls.length > 0) {
    return reply.code(422).send({ error: 'Nie można usunąć pracownika z istniejącymi listami płac' });
  }
  
  const leaveRequests = db.prepare(`
    SELECT id FROM leave_requests WHERE employee_id = ? AND status IN ('pending', 'approved')
  `).all(employeeId);
  
  if (leaveRequests.length > 0) {
    return reply.code(422).send({ error: 'Nie można usunąć pracownika z otwartymi wnioskami urlopowymi' });
  }
  
  db.prepare('DELETE FROM leave_requests WHERE employee_id = ?').run(employeeId);
  db.prepare('DELETE FROM employees WHERE id = ?').run(employeeId);
  
  writeAudit(user.username, 'delete_employee', `employee:${employeeId}`, { name: employee.name, pesel: employee.pesel });
  
  return { success: true };
});

// Payroll API
app.get('/api/payroll', async (request, reply) => {
  const user = requireRole(request, reply, ['admin', 'accountant']);
  if (!user) return;
  
  const { month } = request.query;
  
  if (!month || !isValidMonthFormat(month)) {
    return reply.code(400).send({ error: 'Podaj miesiąc w formacie YYYY-MM' });
  }
  
  const payrolls = db.prepare(`
    SELECT p.*, e.name as employee_name, e.pesel
    FROM payrolls p
    JOIN employees e ON p.employee_id = e.id
    WHERE p.month = ?
    ORDER BY e.name
  `).all(month);
  
  return { payrolls, month };
});

app.post('/api/payroll', async (request, reply) => {
  const user = requireRole(request, reply, ['admin', 'accountant']);
  if (!user) return;
  
  const { month } = request.body || {};
  
  if (!month || !isValidMonthFormat(month)) {
    return reply.code(400).send({ error: 'Podaj miesiąc w formacie YYYY-MM' });
  }
  
  // Check if payroll already exists
  const existingPayroll = db.prepare('SELECT id FROM payrolls WHERE month = ? LIMIT 1').get(month);
  if (existingPayroll) {
    return reply.code(409).send({ error: 'Lista płac dla tego miesiąca już istnieje' });
  }
  
  // Check attempts count for this month
  const attempts = db.prepare('SELECT COUNT(*) as count FROM payroll_attempts WHERE month = ?').get(month);
  
  // Churn logic - 30% chance on first attempt
  if (attempts.count === 0) {
    const delay = 2000 + Math.random() * 6000;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    if (Math.random() < 0.3) {
      db.prepare('INSERT INTO payroll_attempts (month, status, created_at) VALUES (?, ?, ?)').run(
        month,
        'failed',
        new Date().toISOString()
      );
      return reply.code(503).send({ error: 'Lista płac w przygotowaniu, spróbuj ponownie' });
    }
  }
  
  db.prepare('INSERT INTO payroll_attempts (month, status, created_at) VALUES (?, ?, ?)').run(
    month,
    'success',
    new Date().toISOString()
  );
  
  // Get employees hired by end of month who are active
  const [year, monthNum] = month.split('-').map(Number);
  const lastDayOfMonth = new Date(year, monthNum, 0).getDate();
  const monthEndDate = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;
  
  const employees = db.prepare(`
    SELECT * FROM employees
    WHERE hired_at <= ? AND (terminated_at IS NULL OR terminated_at > ?)
    AND active = 1
  `).all(monthEndDate, monthEndDate);
  
  if (employees.length === 0) {
    return reply.code(422).send({ error: 'Brak pracowników do listy płac w tym miesiącu' });
  }
  
  const createdPayrolls = [];
  
  for (const emp of employees) {
    const { zus, pit, net } = computeNet(emp.salary);
    
    db.prepare(`
      INSERT INTO payrolls (month, employee_id, gross, net, status, version, created_at)
      VALUES (?, ?, ?, ?, 'draft', 1, ?)
    `).run(month, emp.id, emp.salary, net, new Date().toISOString());
    
    const payroll = db.prepare('SELECT * FROM payrolls WHERE month = ? AND employee_id = ?').get(month, emp.id);
    createdPayrolls.push(payroll);
  }
  
  writeAudit(user.username, 'create_payroll', `payroll:${month}`, { month, employee_count: employees.length });
  
  return { success: true, payrolls: createdPayrolls, month };
});

app.post('/api/payroll/:id/approve', async (request, reply) => {
  const user = requireRole(request, reply, ['admin', 'accountant']);
  if (!user) return;
  
  const payrollId = parseInt(request.params.id);
  const { version } = request.body || {};
  
  const payroll = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(payrollId);
  if (!payroll) {
    return reply.code(404).send({ error: 'Lista płac nie istnieje' });
  }
  
  if (payroll.status !== 'draft') {
    return reply.code(409).send({ error: 'Lista płac musi być w statusie roboczym do zatwierdzenia' });
  }
  
  if (version !== undefined && payroll.version !== version) {
    return reply.code(409).send({ error: 'Ktoś zmodyfikował ten rekord' });
  }
  
  const approvedAt = new Date().toISOString();
  
  db.prepare(`
    UPDATE payrolls SET status = 'approved', approved_by = ?, approved_at = ?, version = version + 1
    WHERE id = ?
  `).run(user.username, approvedAt, payrollId);
  
  const updatedPayroll = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(payrollId);
  
  writeAudit(user.username, 'approve_payroll', `payroll:${payrollId}`, { month: payroll.month });
  
  return { success: true, payroll: updatedPayroll };
});

app.post('/api/payroll/:id/pay', async (request, reply) => {
  const user = requireRole(request, reply, ['admin', 'accountant']);
  if (!user) return;
  
  const payrollId = parseInt(request.params.id);
  const { version } = request.body || {};
  
  const payroll = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(payrollId);
  if (!payroll) {
    return reply.code(404).send({ error: 'Lista płac nie istnieje' });
  }
  
  if (payroll.status !== 'approved') {
    return reply.code(409).send({ error: 'Lista płac musi być zatwierdzona przed wypłatą' });
  }
  
  if (version !== undefined && payroll.version !== version) {
    return reply.code(409).send({ error: 'Ktoś zmodyfikował ten rekord' });
  }
  
  const paidAt = new Date().toISOString();
  
  db.prepare(`
    UPDATE payrolls SET status = 'paid', paid_at = ?, version = version + 1
    WHERE id = ?
  `).run(paidAt, payrollId);
  
  const updatedPayroll = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(payrollId);
  
  writeAudit(user.username, 'pay_payroll', `payroll:${payrollId}`, { month: payroll.month });
  
  return { success: true, payroll: updatedPayroll };
});

// Leave Requests API
app.get('/api/leave', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  
  const { status } = request.query;
  
  let leaveRequests;
  
  if (user.role === 'employee') {
    const emp = db.prepare('SELECT id FROM employees WHERE name = ?').get(user.full_name);
    if (!emp) {
      return { leave_requests: [] };
    }
    
    let query = `
      SELECT l.*, e.name as employee_name
      FROM leave_requests l
      JOIN employees e ON l.employee_id = e.id
      WHERE l.employee_id = ?
    `;
    let params = [emp.id];
    
    if (status) {
      query += ' AND l.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY l.created_at DESC';
    
    leaveRequests = db.prepare(query).all(...params);
  } else {
    let query = `
      SELECT l.*, e.name as employee_name
      FROM leave_requests l
      JOIN employees e ON l.employee_id = e.id
      WHERE 1=1
    `;
    let params = [];
    
    if (status) {
      query += ' AND l.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY l.created_at DESC';
    
    leaveRequests = db.prepare(query).all(...params);
  }
  
  return { leave_requests: leaveRequests };
});

app.post('/api/leave', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  
  const { type, start_date, end_date, reason } = request.body || {};
  
  if (!isValidDateFormat(start_date)) {
    return reply.code(400).send({ error: 'Data początkowa musi być w formacie YYYY-MM-DD' });
  }
  
  if (!isValidDateFormat(end_date)) {
    return reply.code(400).send({ error: 'Data końcowa musi być w formacie YYYY-MM-DD' });
  }
  
  if (start_date > end_date) {
    return reply.code(400).send({ error: 'Data początkowa nie może być późniejsza niż data końcowa' });
  }
  
  const validTypes = ['vacation', 'sick', 'unpaid'];
  if (!type || !validTypes.includes(type)) {
    return reply.code(400).send({ error: 'Nieprawidłowy typ urlopu' });
  }
  
  // Find employee's ID
  let employeeId;
  
  if (user.role === 'employee') {
    const emp = db.prepare('SELECT id FROM employees WHERE name = ?').get(user.full_name);
    if (!emp) {
      return reply.code(400).send({ error: 'Nie znaleziono pracownika powiązanego z kontem' });
    }
    employeeId = emp.id;
  } else {
    // For admin/accountant, they need to specify employee_id
    if (!request.body.employee_id) {
      return reply.code(400).send({ error: 'ID pracownika jest wymagane' });
    }
    employeeId = parseInt(request.body.employee_id);
    
    const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
    if (!emp) {
      return reply.code(400).send({ error: 'Pracownik o podanym ID nie istnieje' });
    }
  }
  
  // Check for overlapping requests
  const overlapping = db.prepare(`
    SELECT id FROM leave_requests
    WHERE employee_id = ?
    AND status IN ('pending', 'approved')
    AND (
      (start_date <= ? AND end_date >= ?) OR
      (start_date <= ? AND end_date >= ?) OR
      (start_date >= ? AND end_date <= ?)
    )
  `).all(employeeId, end_date, start_date, start_date, start_date, start_date, end_date);
  
  if (overlapping.length > 0) {
    return reply.code(422).send({ error: 'Urlop nakłada się z istniejącym wnioskiem' });
  }
  
  const result = db.prepare(`
    INSERT INTO leave_requests (employee_id, type, start_date, end_date, status, reason, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(employeeId, type, start_date, end_date, reason || null, new Date().toISOString());
  
  const newRequest = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(result.lastInsertRowid);
  
  writeAudit(user.username, 'create_leave', `leave:${newRequest.id}`, { type, start_date, end_date, employee_id: employeeId });
  
  return { success: true, leave_request: newRequest };
});

app.post('/api/leave/:id/review', async (request, reply) => {
  const user = requireRole(request, reply, ['admin', 'accountant']);
  if (!user) return;
  
  const leaveId = parseInt(request.params.id);
  const { approve } = request.body || {};
  
  if (approve === undefined) {
    return reply.code(400).send({ error: 'Wymagany parametr approve (true/false)' });
  }
  
  const leaveRequest = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(leaveId);
  if (!leaveRequest) {
    return reply.code(404).send({ error: 'Wniosek urlopowy nie istnieje' });
  }
  
  if (leaveRequest.status !== 'pending') {
    return reply.code(409).send({ error: 'Ten wniosek został już rozpatrzony' });
  }
  
  const newStatus = approve ? 'approved' : 'rejected';
  const reviewedAt = new Date().toISOString();
  
  db.prepare(`
    UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = ?
    WHERE id = ?
  `).run(newStatus, user.username, reviewedAt, leaveId);
  
  const updatedRequest = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(leaveId);
  
  writeAudit(user.username, 'review_leave', `leave:${leaveId}`, { approved: approve });
  
  return { success: true, leave_request: updatedRequest };
});

// Departments API
app.get('/api/departments', async (request, reply) => {
  const user = requireAuth(request, reply);
  if (!user) return;
  
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  return { departments };
});

app.post('/api/departments', async (request, reply) => {
  const user = requireRole(request, reply, ['admin']);
  if (!user) return;
  
  const { name, cost_center } = request.body || {};
  
  if (!name || name.trim() === '') {
    return reply.code(400).send({ error: 'Nazwa działu jest wymagana' });
  }
  
  if (!cost_center || cost_center.trim() === '') {
    return reply.code(400).send({ error: 'Centrum kosztów jest wymagane' });
  }
  
  const existing = db.prepare('SELECT id FROM departments WHERE name = ?').get(name.trim());
  if (existing) {
    return reply.code(409).send({ error: 'Dział o tej nazwie już istnieje' });
  }
  
  const result = db.prepare(`
    INSERT INTO departments (name, cost_center) VALUES (?, ?)
  `).run(name.trim(), cost_center.trim());
  
  const newDept = db.prepare('SELECT * FROM departments WHERE id = ?').get(result.lastInsertRowid);
  
  writeAudit(user.username, 'create_department', `department:${newDept.id}`, { name, cost_center });
  
  return { success: true, department: newDept };
});

// Audit API
app.get('/api/audit', async (request, reply) => {
  const user = requireRole(request, reply, ['admin']);
  if (!user) return;
  
  const { limit = '50' } = request.query;
  let limitNum = parseInt(limit);
  if (limitNum < 1 || limitNum > 500) limitNum = 50;
  
  const logs = db.prepare(`
    SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?
  `).all(limitNum);
  
  return { audit_log: logs };
});

// Test API
app.post('/api/test/reset', async (request, reply) => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM leave_requests').run();
  db.prepare('DELETE FROM payroll_attempts').run();
  db.prepare('DELETE FROM payrolls').run();
  db.prepare('DELETE FROM employees').run();
  db.prepare('DELETE FROM departments').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();

  // Re-seed demo users
  db.prepare('INSERT INTO users (username, password, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run('admin', 'admin123', 'Administrator', 'admin', 1);
  db.prepare('INSERT INTO users (username, password, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run('accountant', 'account123', 'Księgowy Test', 'accountant', 1);
  db.prepare('INSERT INTO users (username, password, full_name, role, active) VALUES (?, ?, ?, ?, ?)').run('employee', 'employee123', 'Pracownik Test', 'employee', 1);

  return { success: true };
});

app.post('/api/test/seed', async (request, reply) => {
  const { users, departments, employees, payrolls, leaveRequests } = request.body || {};

  const created = {
    users: [],
    departments: [],
    employees: [],
    payrolls: [],
    leaveRequests: []
  };
  
  // Seed users
  if (users && Array.isArray(users)) {
    for (const u of users) {
      if (typeof u.username !== 'string' || typeof u.password !== 'string' || typeof u.full_name !== 'string' || !['admin', 'accountant', 'employee'].includes(u.role)) {
        return reply.code(400).send({ error: 'Nieprawidłowe dane użytkownika' });
      }
      
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
      if (existing) continue;
      
      const result = db.prepare(`
        INSERT INTO users (username, password, full_name, role, active) VALUES (?, ?, ?, ?, ?)
      `).run(u.username, u.password, u.full_name, u.role, u.active !== undefined ? u.active : 1);
      
      const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      created.users.push(newUser);
      writeAudit('seed', 'seed', `user:${newUser.id}`, { username: u.username, role: u.role });
    }
  }
  
  // Seed departments
  if (departments && Array.isArray(departments)) {
    for (const d of departments) {
      if (typeof d.name !== 'string' || typeof d.cost_center !== 'string') {
        return reply.code(400).send({ error: 'Nieprawidłowe dane działu' });
      }
      
      const existing = db.prepare('SELECT id FROM departments WHERE name = ?').get(d.name);
      if (existing) continue;
      
      const result = db.prepare(`
        INSERT INTO departments (name, cost_center) VALUES (?, ?)
      `).run(d.name, d.cost_center);
      
      const newDept = db.prepare('SELECT * FROM departments WHERE id = ?').get(result.lastInsertRowid);
      created.departments.push(newDept);
      writeAudit('seed', 'seed', `department:${newDept.id}`, { name: d.name });
    }
  }
  
  // Seed employees
  if (employees && Array.isArray(employees)) {
    for (const e of employees) {
      if (typeof e.name !== 'string' || typeof e.pesel !== 'string' || typeof e.salary !== 'number') {
        return reply.code(400).send({ error: 'Nieprawidłowe dane pracownika' });
      }
      
      const existing = db.prepare('SELECT id FROM employees WHERE pesel = ?').get(e.pesel);
      if (existing) continue;
      
      let deptId = e.department_id;
      if (e.department_name) {
        let dept = db.prepare('SELECT id FROM departments WHERE name = ?').get(e.department_name);
        if (!dept) {
          const res = db.prepare('INSERT INTO departments (name, cost_center) VALUES (?, ?)')
            .run(e.department_name, 'CC-SEED');
          dept = { id: Number(res.lastInsertRowid) };
        }
        deptId = dept.id;
      }
      if (!deptId) {
        return reply.code(400).send({ error: 'Pracownik musi mieć department_id lub department_name' });
      }
      
      const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(deptId);
      if (!dept) {
        return reply.code(400).send({ error: `Dział ${deptId} nie istnieje` });
      }
      
      const result = db.prepare(`
        INSERT INTO employees (name, pesel, salary, department_id, position, hired_at, active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(e.name, e.pesel, e.salary, deptId, e.position || 'Pracownik', e.hired_at || new Date().toISOString().split('T')[0], e.active !== undefined ? e.active : 1);
      
      const newEmp = db.prepare('SELECT * FROM employees WHERE id = ?').get(result.lastInsertRowid);
      created.employees.push(newEmp);
      writeAudit('seed', 'seed', `employee:${newEmp.id}`, { name: e.name, pesel: e.pesel });
    }
  }
  
  // Seed payrolls
  if (payrolls && Array.isArray(payrolls)) {
    for (const p of payrolls) {
      if (!p.month || typeof p.gross !== 'number') {
        return reply.code(400).send({ error: 'Nieprawidłowe dane listy płac' });
      }
      
      let empId = p.employee_id;
      if (p.employee_pesel) {
        const emp = db.prepare('SELECT id FROM employees WHERE pesel = ?').get(p.employee_pesel);
        if (!emp) continue;
        empId = emp.id;
      }
      if (!empId) {
        return reply.code(400).send({ error: 'Lista płac musi mieć employee_id lub employee_pesel' });
      }
      
      const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(empId);
      if (!emp) continue;
      
      const existing = db.prepare('SELECT id FROM payrolls WHERE month = ? AND employee_id = ?').get(p.month, empId);
      if (existing) continue;
      
      const { net } = computeNet(p.gross);
      
      const result = db.prepare(`
        INSERT INTO payrolls (month, employee_id, gross, net, status, version, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(p.month, empId, p.gross, net, p.status || 'draft', new Date().toISOString());
      
      const newPayroll = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(result.lastInsertRowid);
      created.payrolls.push(newPayroll);
      writeAudit('seed', 'seed', `payroll:${newPayroll.id}`, { month: p.month, employee_id: empId });
    }
  }
  
  // Seed leave requests
  if (leaveRequests && Array.isArray(leaveRequests)) {
    for (const l of leaveRequests) {
      if (!l.type || !l.start_date || !l.end_date) {
        return reply.code(400).send({ error: 'Nieprawidłowe dane wniosku urlopowego' });
      }
      
      let empId = l.employee_id;
      if (l.employee_pesel) {
        const emp = db.prepare('SELECT id FROM employees WHERE pesel = ?').get(l.employee_pesel);
        if (!emp) continue;
        empId = emp.id;
      }
      if (!empId) {
        return reply.code(400).send({ error: 'Wniosek urlopowy musi mieć employee_id lub employee_pesel' });
      }
      
      const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(empId);
      if (!emp) continue;
      
      const result = db.prepare(`
        INSERT INTO leave_requests (employee_id, type, start_date, end_date, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(empId, l.type, l.start_date, l.end_date, l.status || 'pending', l.reason || null, new Date().toISOString());
      
      const newLeave = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(result.lastInsertRowid);
      created.leaveRequests.push(newLeave);
      writeAudit('seed', 'seed', `leave:${newLeave.id}`, { employee_id: empId, type: l.type });
    }
  }
  
  return { success: true, created };
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`HR-Payroll Benchmark server running on port ${PORT}`);
});
