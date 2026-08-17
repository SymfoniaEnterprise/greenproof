/**
 * Programowe API pakietu (to co binarka, bez procesu) do customowych runnerów.
 * Binarka (main.ts) nie jest reeksportowana, żeby import nie odpalał parsowania argv.
 */
export * from './exit-codes.js';
export * from './config.js';
export * from './platform.js';
export * from './commands.js';
