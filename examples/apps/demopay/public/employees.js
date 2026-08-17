const form = document.getElementById('employee-form');
const formError = document.getElementById('employee-form-error');
const tbody = document.getElementById('employees-body');
const logoutLink = document.getElementById('logout-link');

function showFormError(message) {
  formError.textContent = message;
  formError.classList.add('visible');
}

function hideFormError() {
  formError.textContent = '';
  formError.classList.remove('visible');
}

async function loadEmployees() {
  const res = await fetch('/api/employees');
  if (res.status === 401) {
    window.location.href = '/login';
    return;
  }
  if (!res.ok) return;

  const { employees } = await res.json();
  tbody.innerHTML = '';

  for (const emp of employees) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-testid', 'employee-row');

    const nameTd = document.createElement('td');
    nameTd.textContent = emp.name;

    const peselTd = document.createElement('td');
    peselTd.textContent = emp.pesel;

    const salaryTd = document.createElement('td');
    salaryTd.textContent = emp.salary.toFixed(2) + ' zł';

    tr.appendChild(nameTd);
    tr.appendChild(peselTd);
    tr.appendChild(salaryTd);
    tbody.appendChild(tr);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideFormError();

  const name = document.querySelector('[data-testid="employee-name"]').value;
  const pesel = document.querySelector('[data-testid="employee-pesel"]').value;
  const salary = document.querySelector('[data-testid="employee-salary"]').value;

  const res = await fetch('/api/employees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pesel, salary: Number(salary) }),
  });

  if (res.status === 401) {
    window.location.href = '/login';
    return;
  }

  const data = await res.json().catch(() => ({}));

  if (res.ok) {
    form.reset();
    await loadEmployees();
    return;
  }

  showFormError(data.error || 'Nie udało się dodać pracownika');
});

logoutLink.addEventListener('click', async (event) => {
  event.preventDefault();
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

loadEmployees();
