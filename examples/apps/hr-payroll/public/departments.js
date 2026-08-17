const form = document.getElementById('department-form');
const pageError = document.querySelector('[data-testid="departments-page-error"]');
const formError = document.querySelector('[data-testid="department-form-error"]');
const tbody = document.getElementById('departments-tbody');

let sessionData = null;

function showPageError(message) {
    pageError.textContent = message;
    pageError.classList.add('visible');
}

function hidePageError() {
    pageError.textContent = '';
    pageError.classList.remove('visible');
}

function showFormError(message) {
    formError.textContent = message;
    formError.classList.add('visible');
}

function hideFormError() {
    formError.textContent = '';
    formError.classList.remove('visible');
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

async function loadDepartments() {
    hidePageError();
    
    try {
        const response = await fetch('/api/departments');
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        const data = await response.json();
        renderDepartments(data.departments || []);
    } catch (err) {
        showPageError('Błąd ładowania działów');
    }
}

function renderDepartments(departments) {
    tbody.innerHTML = '';
    
    if (departments.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="3" style="text-align: center;">Brak działów</td>';
        tbody.appendChild(tr);
        return;
    }

    departments.forEach(dept => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-testid', 'department-row');
        
        tr.innerHTML = `
            <td>${dept.id}</td>
            <td>${escapeHtml(dept.name)}</td>
            <td>${escapeHtml(dept.cost_center || '-')}</td>
        `;
        tbody.appendChild(tr);
    });
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function submitDepartment(e) {
    e.preventDefault();
    hideFormError();

    const data = {
        name: document.getElementById('department-name').value,
        cost_center: document.getElementById('department-cost-center').value || null
    };

    try {
        const response = await fetch('/api/departments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        if (response.status === 409) {
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
            showFormError(result.error || 'Błąd dodawania działu');
            return;
        }

        form.reset();
        loadDepartments();
    } catch (err) {
        showFormError('Błąd połączenia');
    }
}

// Event Listeners
form.addEventListener('submit', submitDepartment);

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

    // Only admin can access
    if (sessionData.role !== 'admin') {
        showPageError('Brak dostępu. Tylko administrator może zarządzać działami.');
        form.style.display = 'none';
        return;
    }

    await loadDepartments();
}

init();
