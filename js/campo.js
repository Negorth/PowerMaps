(function ($) {
    'use strict';
    var cfg = window.FTTH_CAMPO || {}, ficha = null;
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    }); }
    function chamar(acao, dados, ok) {
        FTTH.chamar({ url: 'campo.php?ajax=' + acao, method: 'POST',
            data: $.extend({ csrf: cfg.csrf }, dados || {}), onOk: ok,
            onErro: function (m) { FTTH.toast('erro', m); } });
    }
    function carregarFicha() {
        FTTH.chamar({ url: 'campo.php?ajax=ficha&caixa=' + encodeURIComponent(cfg.caixa),
            onOk: renderizar, onErro: function (m) { $('#campo-estado').addClass('ftth-aviso ftth-aviso--erro').text(m); } });
    }
    function renderizar(d) {
        ficha = d;
        $('#campo-estado').removeClass('ftth-op-status').text('');
        $('#campo-cabecalho').prop('hidden', false).html('<div class="ftth-op-topo"><div><h2>' + esc(d.nome)
            + '</h2><p class="ftth-sub">' + esc(d.regiao) + ' · ' + esc(d.tipo) + ' · '
            + Number(d.lat).toFixed(6) + ', ' + Number(d.lng).toFixed(6) + '</p></div><div class="ftth-campo-acoes">'
            + '<a class="ftth-btn ftth-btn--sec" href="mapa.php">Voltar ao mapa</a>'
            + '<a class="ftth-btn ftth-btn--sec" href="caixa.php?id=' + Number(d.id) + '">Abrir diagrama</a></div></div>');
        $('#campo-portas-card,#campo-medicao-card,#campo-fotos-card,#campo-etiqueta-card').prop('hidden', false);
        var portas = d.portas || [], total = portas.length, usadas = portas.filter(function (p) { return p.ocupada; }).length;
        var reservadas = portas.filter(function (p) { return !p.ocupada && p.reserva; }).length;
        $('#campo-capacidade').text(usedText(usadas, reservadas, total));
        var splitters = (d.splitters || []).filter(function (s) { return s.funcao === 'ATENDIMENTO'; });
        $('#campo-medicao-splitter').empty().append('<option value="0">Não especificado</option>').append(splitters.map(function (s) {
            return '<option value="' + Number(s.id) + '">' + esc(s.nome) + '</option>';
        }).join(''));
        var groups = splitters.map(function (s) {
            var rows = portas.filter(function (p) { return Number(p.splitter_id) === Number(s.id); });
            return '<section class="ftth-campo-splitter"><h3>' + esc(s.nome) + ' · ' + esc(s.razao)
                + '<small>' + rows.filter(function (p) { return p.ocupada; }).length + '/' + Number(s.saidas) + ' ocupadas</small></h3>'
                + rows.map(portaHtml).join('') + '</section>';
        });
        $('#campo-portas').html(groups.join('') || '<div class="ftth-op-vazio">Nenhum splitter de atendimento documentado.</div>');
        $('#campo-estimativa').html(estimativasHtml(d.estimativas_entrada_cto || [], d.medicoes || []));
        $('#campo-medicoes').html(medicoesHtml(d.medicoes || []));
        $('#campo-fotos').html(fotosHtml(d.fotos || []));
    }
    function usedText(used, reserved, total) {
        return used + ' ocupadas · ' + reserved + ' reservadas · ' + Math.max(0, total - used - reserved) + ' livres / ' + total;
    }
    function portaHtml(p) {
        var titulo = esc(p.splitter_nome) + ' · saída ' + Number(p.numero);
        if (p.ligada_topologia && !p.login) return '<div class="ftth-campo-porta ocupada"><div><strong>' + titulo
            + '</strong><span>Alimenta um cabo ou outro splitter</span></div>'
            + '<span class="ftth-selo ftth-selo--pend">Ligada à topologia</span></div>';
        if (p.ocupada) return '<div class="ftth-campo-porta ocupada"><div><strong>' + titulo + '</strong><span>'
            + esc(p.login || 'ocupada') + (p.identificacao ? ' · ' + esc(p.identificacao) : '') + '</span></div>'
            + (p.reserva ? '<span class="ftth-selo ftth-selo--erro">Reserva em conflito · revisar</span>'
                : '<span class="ftth-selo ftth-selo--pend">Ocupada</span>') + '</div>';
        if (p.reserva) return '<div class="ftth-campo-porta reservada"><div><strong>' + titulo + '</strong><span>'
            + esc(p.reserva.referencia || ('Reservada por ' + p.reserva.reservado_por)) + '</span><small>Expira: '
            + esc(p.reserva.expira_em) + '</small></div><button class="ftth-btn ftth-btn--sec js-reserva-cancelar"'
            + ' data-id="' + Number(p.reserva.id) + '">Cancelar reserva</button></div>';
        return '<div class="ftth-campo-porta livre"><div><strong>' + titulo + '</strong><span>Saída disponível</span></div>'
            + '<button class="ftth-btn ftth-btn--sec js-reservar" data-splitter="' + Number(p.splitter_id)
            + '" data-numero="' + Number(p.numero) + '">Reservar</button></div>';
    }
    function medicoesHtml(lista) {
        if (!lista.length) return '<div class="ftth-op-vazio">Nenhuma medição manual registrada.</div>';
        return '<h3>Medições recentes</h3>' + lista.map(function (m) {
            return '<div class="ftth-campo-registro"><strong>' + Number(m.dbm).toFixed(2) + ' dBm</strong><span>'
                + esc(m.ponto === 'ENTRADA_CTO' ? 'Entrada da CTO' : m.ponto) + (m.lambda_nm ? ' · ' + Number(m.lambda_nm) + ' nm' : '')
                + (m.numero ? ' · saída ' + Number(m.numero) : '') + '</span><small>' + esc(m.medido_por) + ' · '
                + esc(m.medido_em) + (m.observacao ? ' · ' + esc(m.observacao) : '') + '</small></div>';
        }).join('');
    }
    function estimativasHtml(estimativas, medicoes) {
        if (!estimativas.length) return '<div class="ftth-campo-estimativa"><strong>Sem estimativa óptica disponível</strong>'
            + '<span>Confira a ligação da PON e o caminho documentado até esta CTO.</span></div>';
        return '<div class="ftth-campo-estimativas-lista">' + estimativas.map(function (e) {
            var leitura = medicoes.find(function (m) {
                return m.ponto === 'ENTRADA_CTO' && Number(m.splitter_id) === Number(e.splitter_id);
            });
            var html = '<article class="ftth-campo-estimativa"><div><strong>' + esc(e.splitter_nome)
                + ' · potência prevista</strong><span class="ftth-selo ftth-selo--info">estimativa da rota</span></div>';
            if (e.dbm === null || e.dbm === undefined) {
                html += '<span>Sem previsão: ' + esc(e.motivo || 'caminho óptico incompleto') + '</span>';
            } else {
                html += '<strong class="ftth-campo-estimativa-valor">' + Number(e.dbm).toFixed(2) + ' dBm</strong>'
                    + '<span>Potência calculada na entrada do splitter'
                    + (e.desatualizado ? ' · origem da estimativa está desatualizada' : '') + '</span>';
                if (leitura) {
                    var delta = Number(leitura.dbm) - Number(e.dbm);
                    html += '<div class="ftth-campo-diferenca"><strong>Leitura manual: '
                        + Number(leitura.dbm).toFixed(2) + ' dBm</strong><span>Diferença manual − estimativa: '
                        + (delta > 0 ? '+' : '') + delta.toFixed(2) + ' dB'
                        + (leitura.lambda_nm ? ' · ' + Number(leitura.lambda_nm) + ' nm' : ' · onda não informada')
                        + ' · ' + esc(leitura.medido_em) + '</span></div>';
                } else {
                    html += '<span class="ftth-campo-sem-leitura">Ainda sem leitura manual neste mesmo ponto.</span>';
                }
            }
            html += '</article>';
            return html;
        }).join('') + '</div><small class="ftth-campo-estimativa-nota">A comparação só usa leituras marcadas como “Entrada da CTO” e associadas ao mesmo splitter. Confira se o comprimento de onda corresponde ao sinal comparado. Diferenças ajudam na conferência e não substituem certificação óptica.</small>';
    }
    function fotosHtml(lista) {
        if (!lista.length) return '<div class="ftth-op-vazio">Nenhuma foto de campo registrada.</div>';
        return lista.map(function (f) {
            return '<figure class="ftth-campo-foto"><a href="campo.php?foto=' + Number(f.id) + '" target="_blank" rel="noopener">'
                + '<img loading="lazy" src="campo.php?foto=' + Number(f.id) + '" alt="Foto da CTO: ' + esc(f.legenda || 'registro de campo') + '"></a>'
                + '<figcaption>' + esc(f.legenda || 'Foto de campo') + '<small>' + esc(f.enviado_por) + ' · ' + esc(f.criado_em)
                + ' · ' + Math.round(Number(f.bytes) / 1024) + ' KB</small></figcaption></figure>';
        }).join('');
    }
    function buscarCtos(q) {
        if (q.length < 2) { $('#campo-ctos').empty(); return; }
        FTTH.chamar({ url: 'campo.php?ajax=ctos_buscar&q=' + encodeURIComponent(q), onOk: function (d) {
            var itens = d.ctos || [];
            $('#campo-ctos').html(itens.map(function (c) {
                return '<a class="ftth-campo-cto" href="campo.php?caixa=' + Number(c.id) + '"><strong>' + esc(c.nome)
                    + '</strong><span>' + esc(c.regiao) + ' · ' + esc(c.tipo) + '</span></a>';
            }).join('') || '<div class="ftth-op-vazio">Nenhuma CTO encontrada.</div>');
        }});
    }
    $(function () {
        if (cfg.caixa) carregarFicha();
        var timer = null;
        $('#campo-busca').on('input', function () {
            var q = String(this.value); clearTimeout(timer);
            timer = setTimeout(function () { buscarCtos($.trim(q)); }, 220);
        });
        $('#campo-portas').on('click', '.js-reservar', function () {
            var sp = Number($(this).data('splitter')), n = Number($(this).data('numero'));
            $('#campo-reserva-splitter').val(sp); $('#campo-reserva-numero').val(n);
            $('#campo-reserva-alvo').text('· saída ' + n); $('#campo-reserva-form').prop('hidden', false);
            $('#campo-reserva-form')[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        $('#campo-reserva-cancelar').on('click', function () { $('#campo-reserva-form').prop('hidden', true); });
        $('#campo-portas').on('click', '.js-reserva-cancelar', function () {
            var id = Number($(this).data('id'));
            if (!window.confirm('Cancelar esta reserva de porta?')) return;
            chamar('reserva_cancelar', { id: id }, function () { FTTH.toast('ok', 'Reserva cancelada.'); carregarFicha(); });
        });
        $('#campo-reserva-form').on('submit', function (e) {
            e.preventDefault(); var f = this;
            chamar('reserva_criar', { splitter: f.splitter.value, numero: f.numero.value,
                login: f.login.value, referencia: f.referencia.value, horas: f.horas.value }, function () {
                f.reset(); $(f).prop('hidden', true); FTTH.toast('ok', 'Porta reservada.'); carregarFicha();
            });
        });
        $('#campo-medicao-splitter').on('change', function () {
            var val = Number(this.value), entrada = $('#campo-medicao-ponto').val() === 'ENTRADA_CTO';
            $('#campo-medicao-numero').prop('disabled', !val || entrada).prop('required', !!val && !entrada).val('');
            $('#campo-medicao-splitter').prop('required', entrada);
            if (val) {
                var s = ficha && ficha.splitters.find(function (x) { return Number(x.id) === val; });
                if (s) $('#campo-medicao-numero').attr('max', Number(s.saidas));
            }
        });
        $('#campo-medicao-ponto').on('change', function () {
            if (this.value === 'ENTRADA_CTO') $('#campo-medicao-numero').val('');
            $('#campo-medicao-splitter').trigger('change');
        });
        $('#campo-medicao-ponto,#campo-medicao-splitter').trigger('change');
        $('#campo-medicao-form').on('submit', function (e) {
            e.preventDefault(); var f = this;
            chamar('medicao', { caixa: cfg.caixa, dbm: f.dbm.value, ponto: f.ponto.value,
                splitter: f.splitter.value, numero: f.numero.value, lambda: f.lambda.value,
                observacao: f.observacao.value }, function () {
                f.reset(); $('#campo-medicao-splitter').trigger('change');
                FTTH.toast('ok', 'Medição manual salva.'); carregarFicha();
            });
        });
        $('#campo-foto-form').on('submit', function (e) {
            e.preventDefault(); var fd = new FormData(this); fd.append('csrf', cfg.csrf); fd.append('caixa', cfg.caixa);
            $.ajax({ url: 'campo.php?ajax=foto', method: 'POST', data: fd, processData: false, contentType: false })
                .done(function (r) {
                    if (!r || !r.ok) { FTTH.toast('erro', r && r.errors && r.errors[0] ? r.errors[0].message : 'Falha no envio.'); return; }
                    e.target.reset(); FTTH.toast('ok', 'Foto de campo salva com acesso autenticado.'); carregarFicha();
                }).fail(function (xhr) {
                    var r = xhr.responseJSON, m = r && r.errors && r.errors[0] ? r.errors[0].message : 'Falha no envio da foto.';
                    FTTH.toast('erro', m);
                });
        });
        $('#campo-qr-gerar').on('click', function () {
            if (typeof window.qrcode !== 'function') { FTTH.toast('erro', 'Não foi possível carregar o gerador local do QR Code.'); return; }
            var url = window.location.origin + window.location.pathname + '?caixa=' + encodeURIComponent(cfg.caixa);
            var qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
            $('#campo-qr').prop('hidden', false).html('<div class="ftth-campo-qr-caixa">' + esc(ficha ? ficha.nome : 'CTO')
                + '</div><div class="ftth-campo-qr-imagem">' + qr.createSvgTag({ scalable: true, margin: 4 })
                + '</div><small>' + esc(url) + '</small>');
        });
        $('#campo-link-copiar').on('click', function () {
            var url = window.location.origin + window.location.pathname + '?caixa=' + encodeURIComponent(cfg.caixa);
            if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(function () {
                FTTH.toast('ok', 'Link autenticado copiado.');
            }, function () { window.prompt('Copie o link da ficha:', url); });
            else window.prompt('Copie o link da ficha:', url);
        });
        $('#campo-imprimir').on('click', function () { window.print(); });
    });
}(jQuery));
