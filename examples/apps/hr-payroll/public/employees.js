const tbody = document.getElementById('employees-tbody');
const pageError = document.querySelector('[data-testid="employees-page-error"]');
const formError = document.querySelector('[data-testid="employee-form-error"]');
const editError = document.querySelector('[data-testid="employee-edit-error"]');

const searchInput = document.getElementById('employee-search');
const departmentFilter = document.getElementById('employee-filter-department');
const activeFilter = document.getElementById('employee-filter-active');
const sortSelect = document.getElementById('employee-sort');
const sortDirSelect = document.getElementById('employee-sort-dir');
const prevPageBtn = document.getElementById('employee-prev-page');
const nextPageBtn = document.getElementById('employee-next-page');
const pageInfo = document.getElementById('employee-page-info');
const refreshBtn = document.getElementById('employee-refresh');

const addForm = document.getElementById('add-employee-form');
const editForm = document.getElementById('edit-employee-form');
const editModal = document.getElementById('employee-edit-modal');
const confirmDialog = document.getElementById('employee-confirm-dialog');
const confirmMessage = document.getElementById('employee-confirm-message');
const confirmOk = document.getElementById('employee-confirm-ok');
const confirmCancel = document.getElementById('employee-confirm-cancel');

let currentPage = 1;
let pageSize = 10;
let total = 0;
let sessionData = null;
let pendingAction = null;

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

function showEditError(message) {
    editError.textContent = message;
    editError.classList.add('visible');
}

function hideEditError() {
    editError.textContent = '';
    editError.classList.remove('visible');
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
    try {
        const response = await fetch('/api/departments');
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        const data = await response.json();
        
        [departmentFilter, document.getElementById('employee-department'), document.getElementById('edit-employee-department')].forEach(select => {
            if (select) {
                const currentValue = select.value;
                select.innerHTML = '<option value="">Wszystkie działy</option>';
                if (select.id !== 'employee-filter-department') {
                    select.innerHTML = '<option value="">Wybierz dział</option>';
                }
                data.departments.forEach(dept => {
                    const option = document.createElement('option');
                    option.value = dept.id;
                    option.textContent = dept.name;
                    select.appendChild(option);
                });
                select.value = currentValue;
            }
        });
    } catch (err) {
        showPageError('Błąd ładowania działów');
    }
}

async function loadEmployees() {
    hidePageError();
    
    const params = new URLSearchParams({
        page: currentPage,
        pageSize: pageSize,
        sortBy: sortSelect.value,
        sortDir: sortDirSelect.value
    });

    if (searchInput.value) {
        params.append('search', searchInput.value);
    }
    if (departmentFilter.value) {
        params.append('departmentId', departmentFilter.value);
    }
    if (activeFilter.value) {
        params.append('active', activeFilter.value);
    }

    try {
        const response = await fetch(`/api/employees?${params}`);
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        const data = await response.json();
        total = data.total;
        renderEmployees(data.employees);
        renderPagination();
    } catch (err) {
        showPageError('Błąd ładowania pracowników');
    }
}

function renderEmployees(employees) {
    tbody.innerHTML = '';
    
    if (!employees || employees.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="8" style="text-align: center;">Brak pracowników</td>';
        tbody.appendChild(tr);
        return;
    }

    employees.forEach(emp => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-testid', 'employee-row');
        
        const statusClass = emp.active ? 'active' : 'inactive';
        const statusText = emp.active ? 'Aktywny' : 'Nieaktywny';
        
        tr.innerHTML = `
            <td data-testid="employee-name">${escapeHtml(emp.name)}</td>
            <td data-testid="employee-pesel">${escapeHtml(emp.pesel)}</td>
            <td data-testid="employee-department">${escapeHtml(emp.department_name || '')}</td>
            <td data-testid="employee-position">${escapeHtml(emp.position)}</td>
            <td data-testid="employee-salary">${emp.salary.toFixed(2)} zł</td>
            <td data-testid="employee-hired-at">${formatDate(emp.hired_at)}</td>
            <td><span class="badge ${statusClass}">${statusText}</span></td>
            <td class="actions nav-admin" ${sessionData?.role !== 'admin' ? 'style="display:none;"' : ''}>
                <button class="btn btn-secondary" onclick="editEmployee(${emp.id}, '${escapeHtml(emp.name)}', '${emp.pesel}', ${emp.salary}, ${emp.department_id || 'null'}, '${escapeHtml(emp.position)}', '${emp.hired_at}', ${emp.version})" data-testid="employee-edit-btn-${emp.id}">Edytuj</button>
                ${emp.active ? `<button class="btn btn-danger" onclick="terminateEmployee(${emp.id}, '${escapeHtml(emp.name)}')" data-testid="employee-terminate-btn-${emp.id}">Zwolnij</button>` : ''}
                <button class="btn btn-danger" onclick="deleteEmployee(${emp.id}, '${escapeHtml(emp.name)}')" data-testid="employee-delete-btn-${emp.id}">Usuń</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderPagination() {
    const totalPages = Math.ceil(total / pageSize);
    pageInfo.textContent = `Strona ${currentPage} z ${totalPages || 1}`;
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;
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

function showModal(modal) {
    modal.classList.add('visible');
}

function hideModal(modal) {
    modal.classList.remove('visible');
}

function showConfirm(message, action) {
    confirmMessage.textContent = message;
    pendingAction = action;
    showModal(confirmDialog);
}

function hideConfirm() {
    pendingAction = null;
    hideModal(confirmDialog);
}

function editEmployee(id, name, pesel, salary, departmentId, position, hiredAt, version) {
    document.getElementById('edit-employee-id').value = id;
    document.getElementById('edit-employee-version').value = version;
    document.getElementById('edit-employee-name').value = name;
    document.getElementById('edit-employee-pesel').value = pesel;
    document.getElementById('edit-employee-salary').value = salary;
    document.getElementById('edit-employee-department').value = departmentId || '';
    document.getElementById('edit-employee-position').value = position;
    document.getElementById('edit-employee-hired-at').value = hiredAt;
    hideEditError();
    showModal(editModal);
}

async function terminateEmployee(id, name) {
    showConfirm(`Czy na pewno chcesz zwolnić pracownika "${name}"?`, async () => {
        try {
            const response = await fetch(`/api/employees/${id}/terminate`, { method: 'POST' });
            if (response.status === 401) {
                window.location.href = '/login';
                return;
            }
            if (response.status === 422) {
                const data = await response.json();
                showPageError(data.error);
                return;
            }
            if (!response.ok) {
                const data = await response.json();
                showPageError(data.error || 'Błąd zwalniania pracownika');
                return;
            }
            loadEmployees();
        } catch (err) {
            showPageError('Błąd połączenia');
        }
    });
}

async function deleteEmployee(id, name) {
    showConfirm(`Czy na pewno chcesz usunąć pracownika "${name}"? Tej operacji nie można cofnąć!`, async () => {
        try {
            const response = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
            if (response.status === 401) {
                window.location.href = '/login';
                return;
            }
            if (response.status === 422) {
                const data = await response.json();
                showPageError(data.error);
                return;
            }
            if (response.status === 409) {
                const data = await response.json();
                showPageError(data.error);
                return;
            }
            if (!response.ok) {
                const data = await response.json();
                showPageError(data.error || 'Błąd usuwania pracownika');
                return;
            }
            loadEmployees();
        } catch (err) {
            showPageError('Błąd połączenia');
        }
    });
}

async function handleAddEmployee(e) {
    e.preventDefault();
    hideFormError();

    const data = {
        name: document.getElementById('employee-name').value,
        pesel: document.getElementById('employee-pesel').value,
        salary: parseFloat(document.getElementById('employee-salary').value),
        department_id: parseInt(document.getElementById('employee-department').value),
        position: document.getElementById('employee-position').value,
        hired_at: document.getElementById('employee-hired-at').value
    };

    try {
        const response = await fetch('/api/employees', {
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
            showFormError(result.error || 'Błąd dodawania pracownika');
            return;
        }

        addForm.reset();
        currentPage = 1;
        loadEmployees();
    } catch (err) {
        showFormError('Błąd połączenia');
    }
}

async function handleEditEmployee(e) {
    e.preventDefault();
    hideEditError();

    const id = document.getElementById('edit-employee-id').value;
    const data = {
        name: document.getElementById('edit-employee-name').value,
        pesel: document.getElementById('edit-employee-pesel').value,
        salary: parseFloat(document.getElementById('edit-employee-salary').value),
        department_id: parseInt(document.getElementById('edit-employee-department').value),
        position: document.getElementById('edit-employee-position').value,
        hired_at: document.getElementById('edit-employee-hired-at').value,
        version: parseInt(document.getElementById('edit-employee-version').value)
    };

    try {
        const response = await fetch(`/api/employees/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        if (response.status === 409) {
            const result = await response.json();
            showEditError(result.error);
            return;
        }
        if (response.status === 400) {
            const result = await response.json();
            showEditError(result.error);
            return;
        }
        if (!response.ok) {
            const result = await response.json();
            showEditError(result.error || 'Błąd edycji pracownika');
            return;
        }

        hideModal(editModal);
        loadEmployees();
    } catch (err) {
        showEditError('Błąd połączenia');
    }
}

// Event Listeners
addForm.addEventListener('submit', handleAddEmployee);
editForm.addEventListener('submit', handleEditEmployee);

searchInput.addEventListener('input', debounce(() => {
    currentPage = 1;
    loadEmployees();
}, 300));

departmentFilter.addEventListener('change', () => {
    currentPage = 1;
    loadEmployees();
});

activeFilter.addEventListener('change', () => {
    currentPage = 1;
    loadEmployees();
});

sortSelect.addEventListener('change', () => {
    currentPage = 1;
    loadEmployees();
});

sortDirSelect.addEventListener('change', () => {
    currentPage = 1;
    loadEmployees();
});

prevPageBtn.addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        loadEmployees();
    }
});

nextPageBtn.addEventListener('click', () => {
    currentPage++;
    loadEmployees();
});

refreshBtn.addEventListener('click', loadEmployees);

document.getElementById('employee-edit-close').addEventListener('click', () => hideModal(editModal));
document.getElementById('employee-edit-cancel').addEventListener('click', () => hideModal(editModal));

confirmOk.addEventListener('click', async () => {
    hideConfirm();
    if (pendingAction) {
        await pendingAction();
    }
});

confirmCancel.addEventListener('click', hideConfirm);

document.getElementById('logout-link').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (err) {}
    window.location.href = '/login';
});

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Initialize
async function init() {
    sessionData = await loadSession();
    if (!sessionData) return;

    // Show/hide admin elements
    const adminElements = document.querySelectorAll('.nav-admin');
    adminElements.forEach(el => {
        // Jawnie w OBIE strony: HTML startuje z display:none, więc adminowi
        // trzeba elementy POKAZAĆ, nie tylko chować je pozostałym.
        el.style.display = sessionData.role === 'admin' ? '' : 'none';
    });

    const adminAccountantElements = document.querySelectorAll('.nav-admin-accountant');
    adminAccountantElements.forEach(el => {
        if (sessionData.role === 'employee') {
            el.style.display = 'none';
        }
    });

    await loadDepartments();
    loadEmployees();
}

init();
