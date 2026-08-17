function round2(x) {
  return Math.round(x * 100) / 100;
}

export function computeNet(gross) {
  const zus = round2(gross * 0.1371);
  const pit = round2((gross - zus - 250) * 0.12);
  const net = round2(gross - zus - pit);
  return { zus, pit, net };
}
