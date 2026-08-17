function round2(x) {
  return Math.round(x * 100) / 100;
}

export function computeNet(gross) {
  const zus = round2(gross * 0.1371);
  const pit = round2((gross - zus - 250) * 0.12);
  const net = round2(gross - zus - pit);
  return { zus, pit, net };
}

export function validatePesel(pesel) {
  if (!pesel || typeof pesel !== 'string') return false;
  if (pesel.length !== 11) return false;
  if (!/^\d{11}$/.test(pesel)) return false;
  
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(pesel[i]) * weights[i];
  }
  const controlDigit = (10 - (sum % 10)) % 10;
  return controlDigit === parseInt(pesel[10]);
}

export function isValidDateFormat(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  return date.toISOString().startsWith(dateStr);
}

export function isValidMonthFormat(monthStr) {
  if (!monthStr || typeof monthStr !== 'string') return false;
  if (!/^\d{4}-\d{2}$/.test(monthStr)) return false;
  const [year, month] = monthStr.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  if (year < 1900 || year > 2100) return false;
  return true;
}
