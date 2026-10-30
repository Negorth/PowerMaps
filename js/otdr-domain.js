(function (root, factory) {
    'use strict';

    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FTTH_OTDR = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {

    function calcular(leitura, bobina, tolerancia, total) {
        leitura = Number(leitura);
        bobina = Number(bobina);
        tolerancia = Number(tolerancia);
        total = Number(total);
        if (![leitura, bobina, tolerancia, total].every(Number.isFinite)
            || leitura < 0 || bobina < 0 || tolerancia < 0 || tolerancia > 1000 || total <= 0) {
            return { ok: false, erro: 'Confira as distâncias e use uma tolerância entre 0 e 1.000 metros.' };
        }
        var distancia = leitura - bobina;
        if (distancia < 0) {
            return { ok: false, erro: 'A distância indicada é menor que a bobina de lançamento.' };
        }
        if (distancia > total) {
            return { ok: false, erro: 'Após descontar a bobina, a leitura ultrapassa a metragem documentada da rota.' };
        }
        return {
            ok: true,
            distancia: distancia,
            inicio: Math.max(0, distancia - tolerancia),
            fim: Math.min(total, distancia + tolerancia),
            total: total
        };
    }

    return { calcular: calcular };
}));
