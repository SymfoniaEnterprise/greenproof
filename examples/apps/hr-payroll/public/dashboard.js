const greetingEl = document.getElementById('dashboard-greeting');
const employeesCountEl = document.querySelector('[data-testid="dashboard-employees-count"]');
const leavePendingEl = document.querySelector('[data-testid="dashboard-leave-pending"]');
const payrollStatusEl = document.querySelector('[data-testid="dashboard-payroll-status"]');
const payrollMonthEl = document.getElementById('dashboard-payroll-month');
const logoutLink = document.getElementById('logout-link');

let sessionData = null;

async function loadSession() {
    try {
        const response = await fetch('/api/session');
        if (response.status === 401) {
            window.location.href = '/login';
            return null;
        }
        const data = await response.json();
        if (!data.authenticated) {
            window.location.href = '/login';
            return null;
        }
        return data;
    } catch (err) {
        window.location.href = '/login';
        return null;
    }
}

async function loadDashboard() {
    sessionData = await loadSession();
    if (!sessionData) return;

    // Set greeting
    greetingEl.textContent = `Witaj, ${sessionData.full_name}!`;
    greetingEl.setAttribute('data-testid', 'dashboard-greeting');

    // Load employees count
    await loadEmployeesCount();

    // Load pending leave
    await loadPendingLeave();

    // Load current month payroll
    await loadCurrentPayroll();

    // Handle role-based navigation visibility
    handleNavVisibility(sessionData.role);
}

async function loadEmployeesCount() {
    try {
        const response = await fetch('/api/employees?pageSize=1');
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        const data = await response.json();
        employeesCountEl.textContent = data.total || 0;
    } catch (err) {
        employeesCountEl.textContent = '?';
    }
}

async function loadPendingLeave() {
    try {
        const response = await fetch('/api/leave?status=pending');
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        const data = await response.json();
        leavePendingEl.textContent = data.leave_requests ? data.leave_requests.length : 0;
    } catch (err) {
        leavePendingEl.textContent = '?';
    }
}

async function loadCurrentPayroll() {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    payrollMonthEl.textContent = currentMonth;

    try {
        const response = await fetch(`/api/payroll?month=${currentMonth}`);
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        if (response.status === 400) {
            payrollStatusEl.textContent = 'Brak';
            payrollStatusEl.classList.add('badge', 'draft');
            return;
        }
        const data = await response.json();
        if (data.payrolls && data.payrolls.length > 0) {
            const status = data.payrolls[0].status;
            payrollStatusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
            payrollStatusEl.className = 'value';
            payrollStatusEl.classList.add('badge', status);
        } else {
            payrollStatusEl.textContent = 'Brak';
            payrollStatusEl.classList.add('badge', 'draft');
        }
    } catch (err) {
        payrollStatusEl.textContent = '?';
    }
}

function handleNavVisibility(role) {
    const adminOnlyElements = document.querySelectorAll('.nav-admin, .nav-admin-accountant');
    const adminLinks = document.querySelectorAll('.nav-admin');
    const adminAccountantLinks = document.querySelectorAll('.nav-admin-accountant');

    adminOnlyElements.forEach(el => {
        el.style.display = '';
    });

    if (role === 'employee') {
        adminLinks.forEach(el => el.style.display = 'none');
    }

    if (role === 'accountant') {
        adminLinks.forEach(el => el.style.display = 'none');
    }
}

async function handleLogout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (err) {
        // Ignore
    }
    window.location.href = '/login';
}

logoutLink.addEventListener('click', (e) => {
    e.preventDefault();
    handleLogout();
});

// Load dashboard on page load
loadDashboard();
