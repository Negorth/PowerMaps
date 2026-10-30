const assert = require('assert');
const otdr = require('../js/otdr-domain.js');

assert.deepStrictEqual(otdr.calcular(850, 100, 10, 1000), {
  ok: true, distancia: 750, inicio: 740, fim: 760, total: 1000
});
assert.strictEqual(otdr.calcular(50, 100, 0, 1000).ok, false, 'leitura menor que a bobina deve ser rejeitada');
assert.strictEqual(otdr.calcular(1200, 100, 20, 1000).ok, false, 'distância corrigida além da rota deve ser rejeitada');
assert.deepStrictEqual(otdr.calcular(102, 100, 20, 1000), {
  ok: true, distancia: 2, inicio: 0, fim: 22, total: 1000
});
console.log('OTDR domain: OK');
