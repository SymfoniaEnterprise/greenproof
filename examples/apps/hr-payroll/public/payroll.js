const monthInput = document.getElementById('payroll-month');
const loadBtn = document.getElementById('payroll-load');
const createBtn = document.getElementById('payroll-create');
const errorDiv = document.querySelector('[data-testid="payroll-error"]');
const statusDiv = document.querySelector('[data-testid="payroll-status"]');
const tbody = document.getElementById('payroll-tbody');

let sessionData = null;
let currentMonth = '';
let payrollData = null;

function showError(message) {
    errorDiv.textContent = message;
    errorDiv.classList.add('visible');
}

function hideError() {
    errorDiv.textContent = '';
    errorDiv.classList.remove('visible');
}

function showStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = 'status-message visible ' + type;
}

function hideStatus() {
    statusDiv.classList.remove('visible');
}

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

function setDefaultMonth() {
    const now = new Date();
    currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    monthInput.value = currentMonth;
}

async function loadPayroll() {
    if (!currentMonth) {
        showError('Wybierz miesiąc');
        return;
    }
    
    hideError();
    hideStatus();
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Ładowanie...</td></tr>';
    createBtn.disabled = true;

    try {
        const response = await fetch(`/api/payroll?month=${currentMonth}`);
        
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        if (response.status === 400) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Brak listy płac dla tego miesiąca</td></tr>';
            createBtn.disabled = false;
            return;
        }
        
        const data = await response.json();
        payrollData = data;
        
        if (!data.payrolls || data.payrolls.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Brak listy płac dla tego miesiąca</td></tr>';
            createBtn.disabled = false;
            return;
        }
        
        renderPayroll(data.payrolls);
        createBtn.disabled = false;
    } catch (err) {
        showError('Błąd ładowania listy płac');
        tbody.innerHTML = '';
    }
}

function renderPayroll(payrolls) {
    tbody.innerHTML = '';
    
    const isAdminOrAccountant = sessionData && (sessionData.role === 'admin' || sessionData.role === 'accountant');

    payrolls.forEach(p => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-testid', 'payroll-row');
        
        const statusClass = p.status;
        const canApprove = p.status === 'draft' && isAdminOrAccountant;
        const canPay = p.status === 'approved' && isAdminOrAccountant;
        
        tr.innerHTML = `
            <td>${escapeHtml(p.employee_name)}</td>
            <td data-testid="payroll-gross">${p.gross.toFixed(2)} zł</td>
            <td data-testid="payroll-net">${p.net.toFixed(2)} zł</td>
            <td data-testid="payroll-status-badge"><span class="badge ${statusClass}">${translateStatus(p.status)}</span></td>
            <td class="actions">
                ${canApprove ? `<button class="btn btn-success" onclick="approvePayroll(${p.id}, ${p.version})" data-testid="payroll-approve-${p.id}">Zatwierdź</button>` : ''}
                ${canPay ? `<button class="btn btn-primary" onclick="payPayroll(${p.id}, ${p.version})" data-testid="payroll-pay-${p.id}">Zapłać</button>` : ''}
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function translateStatus(status) {
    const translations = {
        'draft': 'Robocza',
        'approved': 'Zatwierdzona',
        'paid': 'Zapłacona'
    };
    return translations[status] || status;
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function createPayroll() {
    hideError();
    createBtn.disabled = true;
    showStatus('Tworzenie listy płac... (proszę czekać)', 'info');

    try {
        const response = await fetch('/api/payroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ month: currentMonth })
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        if (response.status === 409) {
            const data = await response.json();
            showError(data.error);
            hideStatus();
            createBtn.disabled = false;
            return;
        }
        
        if (response.status === 503) {
            const data = await response.json();
            showError(data.error + ' Spróbuj ponownie.');
            hideStatus();
            createBtn.disabled = false;
            return;
        }
        
        if (response.status === 422) {
            const data = await response.json();
            showError(data.error);
            hideStatus();
            createBtn.disabled = false;
            return;
        }
        
        if (response.status === 400) {
            const data = await response.json();
            showError(data.error);
            hideStatus();
            createBtn.disabled = false;
            return;
        }
        
        if (!response.ok) {
            const data = await response.json();
            showError(data.error || 'Błąd tworzenia listy płac');
            hideStatus();
            createBtn.disabled = false;
            return;
        }

        hideStatus();
        loadPayroll();
    } catch (err) {
        showError('Błąd połączenia');
        hideStatus();
        createBtn.disabled = false;
    }
}

async function approvePayroll(id, version) {
    hideError();
    
    try {
        const response = await fetch(`/api/payroll/${id}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version })
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        if (response.status === 409) {
            const data = await response.json();
            showError(data.error);
            return;
        }
        
        if (!response.ok) {
            const data = await response.json();
            showError(data.error || 'Błąd zatwierdzania');
            return;
        }

        loadPayroll();
    } catch (err) {
        showError('Błąd połączenia');
    }
}

async function payPayroll(id, version) {
    hideError();
    
    try {
        const response = await fetch(`/api/payroll/${id}/pay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version })
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        if (response.status === 409) {
            const data = await response.json();
            showError(data.error);
            return;
        }
        
        if (!response.ok) {
            const data = await response.json();
            showError(data.error || 'Błąd płatności');
            return;
        }

        loadPayroll();
    } catch (err) {
        showError('Błąd połączenia');
    }
}

// Event Listeners
loadBtn.addEventListener('click', () => {
    currentMonth = monthInput.value;
    loadPayroll();
});

createBtn.addEventListener('click', createPayroll);

document.getElementById('logout-link').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (err) {}
    window.location.href = '/login';
});

// Initialize
async function init() {
    sessionData = await loadSession();
    if (!sessionData) return;

    // Check if user has access
    if (sessionData.role === 'employee') {
        document.querySelector('.nav-admin-accountant').style.display = 'none';
        showError('Brak dostępu do list płac');
        createBtn.style.display = 'none';
        return;
    }

    setDefaultMonth();
    loadPayroll();
}

init();
