const form = document.getElementById('leave-form');
const errorDiv = document.querySelector('[data-testid="leave-form-error"]');
const tbody = document.getElementById('leave-tbody');
const employeeSelect = document.getElementById('leave-employee');
const employeeGroup = document.getElementById('leave-employee-group');

let sessionData = null;

function showFormError(message) {
    errorDiv.textContent = message;
    errorDiv.classList.add('visible');
}

function hideFormError() {
    errorDiv.textContent = '';
    errorDiv.classList.remove('visible');
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

async function loadEmployees() {
    try {
        const response = await fetch('/api/employees?pageSize=1000&active=true');
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        const data = await response.json();
        
        employeeSelect.innerHTML = '<option value="">Wybierz pracownika</option>';
        data.employees.forEach(emp => {
            const option = document.createElement('option');
            option.value = emp.id;
            option.textContent = emp.name;
            employeeSelect.appendChild(option);
        });
    } catch (err) {
        showFormError('Błąd ładowania listy pracowników');
    }
}

async function loadLeave() {
    try {
        const response = await fetch('/api/leave');
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        const data = await response.json();
        renderLeave(data.leave_requests || []);
    } catch (err) {
        showFormError('Błąd ładowania wniosków');
    }
}

function renderLeave(requests) {
    tbody.innerHTML = '';
    
    if (requests.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="7" style="text-align: center;">Brak wniosków urlopowych</td>';
        tbody.appendChild(tr);
        return;
    }

    const isAdminOrAccountant = sessionData && (sessionData.role === 'admin' || sessionData.role === 'accountant');

    requests.forEach(req => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-testid', 'leave-row');
        
        const canReview = req.status === 'pending' && isAdminOrAccountant;
        
        tr.innerHTML = `
            <td>${escapeHtml(req.employee_name)}</td>
            <td>${translateType(req.type)}</td>
            <td>${formatDate(req.start_date)}</td>
            <td>${formatDate(req.end_date)}</td>
            <td><span class="badge ${req.status}">${translateStatus(req.status)}</span></td>
            <td>${escapeHtml(req.reason || '-')}</td>
            <td class="actions">
                ${canReview ? `
                    <button class="btn btn-success" onclick="reviewLeave(${req.id}, true)" data-testid="leave-approve-${req.id}">Zatwierdź</button>
                    <button class="btn btn-danger" onclick="reviewLeave(${req.id}, false)" data-testid="leave-reject-${req.id}">Odrzuć</button>
                ` : ''}
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function translateType(type) {
    const translations = {
        'wypoczynkowy': 'Wypoczynkowy',
        'chorobowy': 'Chorobowy',
        'rodzicielski': 'Rodzicielski',
        'na żądanie': 'Na żądanie',
        'bezpłatny': 'Bezpłatny'
    };
    return translations[type] || type;
}

function translateStatus(status) {
    const translations = {
        'pending': 'Oczekuje',
        'approved': 'Zatwierdzony',
        'rejected': 'Odrzucony'
    };
    return translations[status] || status;
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('pl-PL');
}

async function submitLeave(e) {
    e.preventDefault();
    hideFormError();

    const data = {
        type: document.getElementById('leave-type').value,
        start_date: document.getElementById('leave-start').value,
        end_date: document.getElementById('leave-end').value,
        reason: document.getElementById('leave-reason').value
    };

    // Admin/accountant must specify employee
    if (sessionData.role !== 'employee') {
        const employeeId = employeeSelect.value;
        if (!employeeId) {
            showFormError('Wybierz pracownika');
            return;
        }
        data.employee_id = parseInt(employeeId);
    }

    try {
        const response = await fetch('/api/leave', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        if (response.status === 422) {
            const result = await response.json();
            showFormError(result.error);
            return;
        }
        
        if (response.status === 400) {
            const result = await response.json();
            showFormError(result.error);
            return;
        }
        
        if (!response.ok) {
            const result = await response.json();
            showFormError(result.error || 'Błąd składania wniosku');
            return;
        }

        form.reset();
        loadLeave();
    } catch (err) {
        showFormError('Błąd połączenia');
    }
}

async function reviewLeave(id, approve) {
    try {
        const response = await fetch(`/api/leave/${id}/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approve })
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        if (response.status === 409) {
            const data = await response.json();
            showFormError(data.error);
            return;
        }
        
        if (!response.ok) {
            const data = await response.json();
            showFormError(data.error || 'Błąd rozpatrywania wniosku');
            return;
        }

        loadLeave();
    } catch (err) {
        showFormError('Błąd połączenia');
    }
}

// Event Listeners
form.addEventListener('submit', submitLeave);

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

    // Show employee selector for admin/accountant
    if (sessionData.role !== 'employee') {
        employeeGroup.style.display = '';
        await loadEmployees();
    }

    await loadLeave();
}

init();
