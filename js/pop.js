/**
 * ftth_doc :: POP / Data Center.
 *
 * A tela desenha os cards de OLT e DIO a partir de um único `estado` recarregado por AJAX —
 * padrão do importar.php, porque tudo aqui depende de um POP escolhido.
 *
 * O único ponto que sai do CRUD é a "saída para a rua": o seletor grava uma ligação de
 * verdade no grafo, a mesma que o diagrama criaria. Por isso ele fala com `definir_saida`
 * e não com o `alterar_porta`.
 */
(function () {
    'use strict';

    var estado = { olts: [], olts_oltmanager: [], oltmanager_disponivel: false, dios: [], saidas: [], porta: null, placas: [], oltEditando: null };

    function esc(s) { return FTTH.esc(s); }

    function aviso(sel, texto, tipo) {
        $(sel).html('<div class="ftth-aviso ' + (tipo || '') + '">' +
                    esc(texto).replace(/\n/g, '<br>') + '</div>');
    }

    /*
     * Cor do tubo e da fibra: é o que o técnico procura na bandeja, não o número. Quadradinho
     * é o tubo (só em multitubo: em monotubo o tubo é sempre o 1 e não diz nada), bolinha é a
     * fibra. Cor clara ganha o contorno do catálogo (Fibra::CORES) para não sumir no branco.
     */
    function marcasCor(s) {
        if (!s || !s.cor) return '';
        var marca = function (hex, contorno, classe) {
            return '<i class="ftth-fibra-cor' + classe + '" style="background:' + esc(hex)
                 + ';border-color:' + esc(contorno || hex) + '"></i>';
        };
        return (s.multitubo ? marca(s.cor_tubo, s.contorno_tubo, ' ftth-fibra-cor--tubo') : '')
             + marca(s.cor, s.contorno, '');
    }

    function nomesCor(s, curto) {
        if (!s || !s.cor_nome) return '';
        if (curto) return (s.multitubo ? 'T' + s.tubo + ' ' + s.cor_tubo_nome + ' / ' : '') + s.cor_nome;
        return (s.multitubo ? 'Tubo ' + s.tubo + ' ' + s.cor_tubo_nome + ' · ' : '') + 'Fibra ' + s.cor_nome;
    }

    /** A amostra abaixo do seletor de saída acompanha a opção escolhida. */
    function amostraSaida() {
        var i = $('#porta-saida option:selected').data('i');
        var s = i === undefined ? null : estado.saidas[i];
        $('#porta-saida-cor').html(s ? marcasCor(s) + ' ' + esc(nomesCor(s)) : '');
    }

    /* ------------------------------------------------------------------ carga */

    function carregar(aoTerminar) {
        FTTH.chamar({
            url: 'pop.php?ajax=estado&caixa=' + CAIXA,
            onOk: function (d) {
                estado.olts   = d.olts   || [];
                estado.olts_oltmanager = d.olts_oltmanager || [];
                estado.oltmanager_disponivel = !!d.oltmanager_disponivel;
                estado.dios   = d.dios   || [];
                estado.saidas = d.saidas || [];
                desenharOlts();
                desenharDios();
                if (aoTerminar) aoTerminar();
            },
            onErro: function (m) { aviso('#saida', m, 'ftth-aviso--erro'); }
        });
    }

    /* ------------------------------------------------------------------ OLT */

    function desenharOlts() {
        var html = '';
        estado.olts.forEach(function (o) {
            var nativa = o.nativa
                ? esc(o.nativa.name) + ' · ' + esc(o.nativa.ipaddress) + ':' + esc(o.nativa.access_port)
                : '<span class="ftth-sub">sem vínculo com o cadastro</span>';

            html += '<div class="ftth-card ftth-card--olt">'
                 +  '<h2><i class="bi-hdd-network-fill"></i> ' + esc(o.apelido) + '</h2>'
                 +  '<dl class="ftth-ficha">'
                 +    '<dt>Fabricante</dt><dd>' + esc(o.fabricante || (o.nativa ? o.nativa.maker : '—')) + '</dd>'
                 +    '<dt>Host</dt><dd>' + nativa + '</dd>'
                 +    '<dt>Capacidade</dt><dd>' + o.pons.length + ' portas PON em ' + o.placas.length + ' placa(s)</dd>'
                 +    '<dt>Potência</dt><dd>' + Number(o.ptx_dbm).toFixed(2) + ' dBm · classe ' + esc(o.classe_optica) + '</dd>'
                 +    '<dt>Acesso</dt><dd>' + (o.acesso === 'simulado'
                        ? '<span class="ftth-selo ftth-selo--pend">modo simulado</span>' : esc(o.acesso)) + '</dd>'
                 +  '</dl>';

            html += '<div class="ftth-pop-acoes">'
                 +  '<button class="ftth-btn ftth-btn--sec js-olt-editar" data-id="' + o.id + '">'
                 +  '<i class="bi-gear"></i> Configurar</button>'
                 +  '<button class="ftth-btn ftth-btn--sec js-olt-excluir" data-id="' + o.id
                 +  '" data-versao="' + o.versao + '"><i class="bi-trash3"></i> Excluir</button></div>';
            html += '</div>';
        });
        $('#lista-olts').html(html);
    }

    function oltPorId(id) {
        for (var i = 0; i < estado.olts.length; i++) {
            if (parseInt(estado.olts[i].id, 10) === parseInt(id, 10)) return estado.olts[i];
        }
        return null;
    }

    function abrirModalOlt(o) {
        estado.oltEditando = o;
        estado.placas = o ? o.placas.map(function (p) {
            return { prefixo: p.prefixo, portas: parseInt(p.portas, 10), inicio: parseInt(p.inicio, 10) };
        }) : [{ prefixo: '0/1', portas: 16, inicio: 1 }];

        var opc = '<option value="0">— sem vínculo —</option>';
        NATIVAS.forEach(function (n) {
            opc += '<option value="' + n.id + '">' + esc(n.name) + ' (' + esc(n.maker) + ')</option>';
        });
        $('#olt-nativa').html(opc).val(o && o.olt_id ? o.olt_id : '0');

        var managerOpc = '<option value="0">— sem vínculo —</option>';
        var managerFound = false;
        estado.olts_oltmanager.forEach(function (m) {
            managerOpc += '<option value="' + Number(m.id) + '">' + esc(m.nome) + ' (' + esc(m.fabricante || '') + ')</option>';
            if (o && Number(o.oltmanager_olt_id) === Number(m.id)) managerFound = true;
        });
        if (o && Number(o.oltmanager_olt_id) > 0 && !managerFound) {
            managerOpc += '<option value="' + Number(o.oltmanager_olt_id) + '">Vínculo atual indisponível</option>';
        }
        $('#olt-oltmanager').html(managerOpc).val(o && o.oltmanager_olt_id ? String(o.oltmanager_olt_id) : '0')
            .prop('disabled', !estado.oltmanager_disponivel);
        $('#olt-manager-ajuda').text(estado.oltmanager_disponivel
            ? 'Vínculo usado somente para ler TX e horário das PONs no OLTManager.'
            : 'OLTManager indisponível. O vínculo atual será preservado; o cálculo manual continua disponível.');

        var fab = '<option value="">—</option>';
        FABRICANTES.forEach(function (f) { fab += '<option>' + esc(f) + '</option>'; });
        fab += '<option value="Outro">Outro</option>';
        $('#olt-fabricante').html(fab).val(o && o.fabricante ? o.fabricante : '');

        $('#olt-titulo').text(o ? 'Configurar ' + o.apelido : 'Vincular nova OLT');
        $('#olt-apelido').val(o ? o.apelido : '');
        $('#olt-ptx').val(o ? Number(o.ptx_dbm).toFixed(2) : '3.00');
        $('#olt-saida').empty();
        desenharPlacas();
        $('#modal-olt').show();
    }

    function desenharPlacas() {
        var html = '';
        estado.placas.forEach(function (p, i) {
            html += '<div class="ftth-pop-placa">'
                 +  '<label class="ftth-sub">Prefixo/slot<input class="ftth-campo js-placa" data-i="' + i
                 +  '" data-campo="prefixo" value="' + esc(p.prefixo) + '" maxlength="20"></label>'
                 +  '<label class="ftth-sub">Portas<input class="ftth-campo js-placa" data-i="' + i
                 +  '" data-campo="portas" type="number" min="1" max="64" value="' + p.portas + '"></label>'
                 +  '<label class="ftth-sub">Início<input class="ftth-campo js-placa" data-i="' + i
                 +  '" data-campo="inicio" type="number" min="0" max="64" value="' + p.inicio + '"></label>'
                 +  '<button class="ftth-btn ftth-btn--sec js-placa-remover" data-i="' + i
                 +  '" title="Remover placa"><i class="bi-trash3"></i></button></div>';
        });
        if (!estado.placas.length) {
            html = '<p class="ftth-sub">Nenhuma placa — o seletor de PON da porta ficará vazio.</p>';
        }
        $('#olt-placas').html(html);
    }

    function salvarOlt() {
        var o = estado.oltEditando;
        var $b = $('#btn-olt-salvar').prop('disabled', true);

        FTTH.chamar({
            url: 'pop.php?ajax=' + (o ? 'alterar_olt' : 'criar_olt'),
            method: 'POST',
            data: {
                csrf: CSRF, caixa: CAIXA, olt: o ? o.id : 0, versao: o ? o.versao : null,
                apelido: $('#olt-apelido').val(),
                fabricante: $('#olt-fabricante').val(),
                olt_id: $('#olt-nativa').val(),
                oltmanager_olt_id: $('#olt-oltmanager').val(),
                ptx_dbm: $('#olt-ptx').val(),
                placas: JSON.stringify(estado.placas)
            },
            onOk: function () {
                $('#modal-olt').hide();
                carregar(function () { aviso('#saida', 'OLT salva.', 'ftth-aviso--ok'); });
            },
            onErro: function (m) { aviso('#olt-saida', m, 'ftth-aviso--erro'); }
        }).always(function () { $b.prop('disabled', false); });
    }

    /* ------------------------------------------------------------------ DIO e grade */

    function desenharDios() {
        var html = '';
        estado.dios.forEach(function (d) {
            var usadas = 0;
            d.portas_lista.forEach(function (p) { if (p.status !== 'vazia') usadas++; });

            html += '<div class="ftth-card">'
                 +  '<h2><i class="bi-grid-3x3-gap-fill"></i> ' + esc(d.nome)
                 +  ' <span class="ftth-selo ftth-selo--info">' + d.portas + ' portas</span>'
                 +  ' <span class="ftth-selo ' + (parseInt(d.ativo, 10) ? 'ftth-selo--ok' : 'ftth-selo--pend') + '">'
                 +  (parseInt(d.ativo, 10) ? 'painel ativo' : 'inativo') + '</span></h2>'
                 +  '<p class="ftth-sub">' + usadas + ' de ' + d.portas + ' portas em uso · '
                 +  'cada cartão traz equipamento, serviço e saída para a rua</p>'
                 +  '<div class="ftth-portas-rolagem"><div class="ftth-portas">';

            d.portas_lista.forEach(function (p) {
                html += '<button class="ftth-porta ftth-porta--' + p.status + ' js-porta" data-id="' + p.id + '"'
                     +  (p.saida && p.saida.cor_nome
                            ? ' title="' + esc(p.saida.rotulo + ' · ' + nomesCor(p.saida)) + '"' : '') + '>'
                     +  '<span class="ftth-porta-topo">' + esc(p.rotulo) + '<i class="ftth-porta-luz"></i></span>'
                     +  '<span class="ftth-porta-linha">' + (p.olt_apelido
                            ? esc(p.olt_apelido) + (p.pon ? ' · ' + esc(p.pon) : '') : '—') + '</span>'
                     +  '<span class="ftth-porta-linha">' + (p.servico ? esc(p.servico) : '—') + '</span>'
                     +  '<span class="ftth-porta-linha">' + (p.saida ? marcasCor(p.saida) + esc(p.saida.rotulo) : '—') + '</span>'
                     +  '</button>';
            });

            html += '</div></div>';
            html += '<div class="ftth-pop-acoes" style="margin-top:12px">'
                 +  '<button class="ftth-btn ftth-btn--sec js-dio-editar" data-id="' + d.id + '">'
                 +  '<i class="bi-pencil"></i> Renomear / capacidade</button>'
                 +  '<button class="ftth-btn ftth-btn--sec js-dio-excluir" data-id="' + d.id
                 +  '" data-versao="' + d.versao + '"><i class="bi-trash3"></i> Excluir</button></div>';
            html += '</div>';
        });
        $('#lista-dios').html(html || '<div class="ftth-card"><p class="ftth-sub">'
            + 'Nenhum DIO instalado neste POP ainda.</p></div>');
    }

    function portaPorId(id) {
        for (var i = 0; i < estado.dios.length; i++) {
            var lista = estado.dios[i].portas_lista;
            for (var j = 0; j < lista.length; j++) {
                if (parseInt(lista[j].id, 10) === parseInt(id, 10)) {
                    lista[j].dio_nome = estado.dios[i].nome;
                    return lista[j];
                }
            }
        }
        return null;
    }

    function oltPorIdFtth(id) {
        for (var i = 0; i < estado.olts.length; i++) {
            if (Number(estado.olts[i].id) === Number(id)) return estado.olts[i];
        }
        return null;
    }

    function ponNormalizada(nome) {
        return String(nome || '').replace(/\s+/g, ' ').trim().toUpperCase();
    }

    function atualizarPonsOltManager(preferida, tentarCorrespondencia) {
        var equipamento = ($('#porta-equipamento').val() || '||').split('|');
        var olt = oltPorIdFtth(equipamento[0]);
        var pons = olt ? (olt.oltmanager_pons || []) : [];
        var selecionada = Number(preferida) || 0;
        var existe = pons.some(function (p) { return Number(p.id) === selecionada; });
        var indisponivel = selecionada > 0 && !existe;
        if (!existe && tentarCorrespondencia) selecionada = 0;

        if (!selecionada && tentarCorrespondencia && equipamento[1]) {
            var rotulo = ponNormalizada(equipamento[1]);
            var correspondentes = pons.filter(function (p) { return ponNormalizada(p.nome) === rotulo; });
            if (correspondentes.length === 1) selecionada = Number(correspondentes[0].id);
        }

        var html = '<option value="0">— sem vínculo; usar TX manual —</option>';
        if (indisponivel && !tentarCorrespondencia) {
            html += '<option value="' + selecionada + '">Vínculo salvo · PON indisponível no OLTManager</option>';
        }
        pons.forEach(function (p) {
            var tx = p.tx_power === null || p.tx_power === '' || p.tx_power === undefined
                ? 'sem TX coletado' : 'TX ' + p.tx_power + ' dBm';
            html += '<option value="' + Number(p.id) + '">' + esc(p.nome) + ' · ' + esc(tx) + '</option>';
        });
        $('#porta-pon-manager').html(html).val(String(selecionada))
            .prop('disabled', !estado.oltmanager_disponivel || (!pons.length && !indisponivel));

        var ajuda = !estado.oltmanager_disponivel
            ? 'OLTManager indisponível; o campo manual de TX permanece ativo.'
            : (!olt || !Number(olt.oltmanager_olt_id)
                ? 'Vincule esta OLT do POP ao OLTManager para listar as PONs.'
                : (indisponivel && !tentarCorrespondencia
                    ? 'A PON salva não está ativa ou foi movida. O vínculo fica preservado ao editar outros campos; o TX não será usado até ela voltar à OLT vinculada.'
                    : (!pons.length ? 'Nenhuma PON ativa foi encontrada para a OLT vinculada.'
                        : (selecionada ? 'Vínculo definido. O TX coletado será usado quando estiver disponível.'
                            : 'Selecione a PON correspondente. A associação automática só ocorre ao trocar OLT/PON local e com nome único idêntico.'))));
        $('#porta-pon-manager-ajuda').text(ajuda);
    }

    function abrirPorta(id) {
        var p = portaPorId(id);
        if (!p) return;
        estado.porta = p;

        // Equipamento: cada PON de cada OLT vira uma opção.
        var opc = '<option value="||">— sem equipamento —</option>';
        estado.olts.forEach(function (o) {
            o.pons.forEach(function (pon) {
                opc += '<option value="' + o.id + '|' + esc(pon) + '">'
                     + esc(o.apelido) + ' · ' + esc(pon) + '</option>';
            });
        });
        $('#porta-equipamento').html(opc)
            .val(p.olt_ftth_id ? (p.olt_ftth_id + '|' + (p.pon || '')) : '||');
        atualizarPonsOltManager(p.oltmanager_pon_id, false);

        // Saída OSP: fibras livres mais a que esta porta já usa.
        var saidas = '<option value="|">— sem saída —</option>';
        estado.saidas.forEach(function (s, i) {
            var atual = p.saida && parseInt(p.saida.vao_id, 10) === parseInt(s.vao_id, 10)
                        && parseInt(p.saida.numero, 10) === parseInt(s.numero, 10);
            if (s.estado !== 'livre' && !atual) return;   // ocupada por outra ponta
            // <option> não aceita cor: o nome vai no texto, e a amostra colorida fica abaixo.
            saidas += '<option value="' + s.vao_id + '|' + s.numero + '"' + (atual ? ' selected' : '')
                    + ' data-i="' + i + '">'
                    + esc(s.rotulo) + (s.cor_nome ? ' · ' + esc(nomesCor(s, true)) : '') + '</option>';
        });
        $('#porta-saida').html(saidas);
        $('#porta-saida-contexto').text('DIO: ' + (p.dio_nome || 'não identificado')
            + ' · Porta ' + p.rotulo);
        amostraSaida();

        $('#porta-titulo').text('Porta ' + p.rotulo);
        $('#porta-operacao').val(p.operacao);
        $('#porta-servico').val(p.servico || '');
        $('#porta-ptx').val(p.ptx_dbm === null ? '' : Number(p.ptx_dbm).toFixed(2));
        $('#porta-saida-msg').empty();
        $('#painel-porta').show();
    }

    /**
     * Salva a porta em dois passos: os dados internos e, se mudou, a saída.
     * São operações diferentes — uma é UPDATE de cadastro, a outra mexe no grafo.
     */
    function salvarPorta() {
        var p = estado.porta;
        if (!p) return;

        var equip = ($('#porta-equipamento').val() || '||').split('|');
        var $b = $('#btn-porta-salvar').prop('disabled', true);

        FTTH.chamar({
            url: 'pop.php?ajax=alterar_porta',
            method: 'POST',
            data: {
                csrf: CSRF, porta: p.id, versao: p.versao,
                operacao: $('#porta-operacao').val(),
                olt_ftth_id: equip[0] || 0,
                oltmanager_pon_id: $('#porta-pon-manager').val() || 0,
                pon: equip[1] || '',
                servico: $('#porta-servico').val(),
                ptx_dbm: $('#porta-ptx').val()
            },
            onOk: function () { salvarSaida(p); },
            onErro: function (m) {
                aviso('#porta-saida-msg', m, 'ftth-aviso--erro');
                $b.prop('disabled', false);
            }
        });
    }

    function salvarSaida(p) {
        var escolha = ($('#porta-saida').val() || '|').split('|');
        var vao  = parseInt(escolha[0], 10) || 0;
        var num  = parseInt(escolha[1], 10) || 0;
        var tinha = p.saida ? (parseInt(p.saida.vao_id, 10) + '|' + parseInt(p.saida.numero, 10)) : '0|0';

        if ((vao + '|' + num) === tinha) {          // nada mudou na saída
            $('#btn-porta-salvar').prop('disabled', false);
            $('#painel-porta').hide();
            carregar(function () { aviso('#saida', 'Porta ' + p.rotulo + ' salva.', 'ftth-aviso--ok'); });
            return;
        }

        FTTH.chamar({
            url: 'pop.php?ajax=definir_saida',
            method: 'POST',
            data: { csrf: CSRF, porta: p.id, vao: vao, numero: num },
            onOk: function () {
                $('#painel-porta').hide();
                carregar(function () { aviso('#saida', 'Porta ' + p.rotulo + ' salva.', 'ftth-aviso--ok'); });
            },
            onErro: function (m) { aviso('#porta-saida-msg', m, 'ftth-aviso--erro'); }
        }).always(function () { $('#btn-porta-salvar').prop('disabled', false); });
    }

    /* ------------------------------------------------------------------ eventos */

    $(function () {
        carregar();

        $('#btn-nova-olt').on('click', function () { abrirModalOlt(null); });
        $(document).on('click', '.js-olt-editar', function () {
            abrirModalOlt(oltPorId($(this).attr('data-id')));
        });
        $('#btn-olt-cancelar, #btn-olt-fechar').on('click', function () { $('#modal-olt').hide(); });
        $('#btn-olt-salvar').on('click', salvarOlt);
        $('#porta-equipamento').on('change', function () { atualizarPonsOltManager(0, true); });

        $('#btn-add-placa').on('click', function () {
            estado.placas.push({ prefixo: '', portas: 16, inicio: 1 });
            desenharPlacas();
        });
        $(document).on('click', '.js-placa-remover', function () {
            estado.placas.splice(parseInt($(this).attr('data-i'), 10), 1);
            desenharPlacas();
        });
        $('#porta-saida').on('change', amostraSaida);
        $(document).on('change', '.js-placa', function () {
            var i = parseInt($(this).attr('data-i'), 10);
            var campo = $(this).attr('data-campo');
            estado.placas[i][campo] = campo === 'prefixo' ? $(this).val() : parseInt($(this).val(), 10);
        });

        $(document).on('click', '.js-olt-excluir', function () {
            var id = $(this).attr('data-id'), v = $(this).attr('data-versao');
            var o = oltPorId(id);
            if (!window.confirm('Excluir a OLT ' + (o ? o.apelido : '') + '?')) return;
            FTTH.chamar({
                url: 'pop.php?ajax=excluir_olt', method: 'POST',
                data: { csrf: CSRF, olt: id, versao: v },
                onOk: function () { carregar(function () { aviso('#saida', 'OLT excluída.', 'ftth-aviso--ok'); }); },
                onErro: function (m) { aviso('#saida', m, 'ftth-aviso--erro'); }
            });
        });

        $('#btn-novo-dio').on('click', function () {
            $('#dio-titulo').text('Instalar novo DIO');
            $('#dio-nome').val('');
            $('#dio-portas').val(24);
            $('#dio-saida').empty();
            $('#modal-dio').data('id', 0).show();
        });
        $(document).on('click', '.js-dio-editar', function () {
            var id = $(this).attr('data-id');
            var d = null;
            estado.dios.forEach(function (x) { if (parseInt(x.id, 10) === parseInt(id, 10)) d = x; });
            if (!d) return;
            $('#dio-titulo').text('Alterar ' + d.nome);
            $('#dio-nome').val(d.nome);
            $('#dio-portas').val(d.portas);
            $('#dio-saida').empty();
            $('#modal-dio').data('id', d.id).data('versao', d.versao).show();
        });
        $('#btn-dio-cancelar, #btn-dio-fechar').on('click', function () { $('#modal-dio').hide(); });

        $('#btn-dio-salvar').on('click', function () {
            var id = $('#modal-dio').data('id');
            var $b = $(this).prop('disabled', true);
            FTTH.chamar({
                url: 'pop.php?ajax=' + (id ? 'alterar_dio' : 'criar_dio'),
                method: 'POST',
                data: { csrf: CSRF, caixa: CAIXA, dio: id, versao: $('#modal-dio').data('versao'),
                        nome: $('#dio-nome').val(), portas: $('#dio-portas').val() },
                onOk: function () {
                    $('#modal-dio').hide();
                    carregar(function () { aviso('#saida', 'DIO salvo.', 'ftth-aviso--ok'); });
                },
                onErro: function (m) { aviso('#dio-saida', m, 'ftth-aviso--erro'); }
            }).always(function () { $b.prop('disabled', false); });
        });

        $(document).on('click', '.js-dio-excluir', function () {
            var id = $(this).attr('data-id'), v = $(this).attr('data-versao');
            if (!window.confirm('Excluir este DIO?\n\nSó sai se nenhuma porta tiver fibra ligada.')) return;
            FTTH.chamar({
                url: 'pop.php?ajax=excluir_dio', method: 'POST',
                data: { csrf: CSRF, dio: id, versao: v },
                onOk: function () { carregar(function () { aviso('#saida', 'DIO excluído.', 'ftth-aviso--ok'); }); },
                onErro: function (m) { aviso('#saida', m, 'ftth-aviso--erro'); }
            });
        });

        $(document).on('click', '.js-porta', function () {
            abrirPorta($(this).attr('data-id'));
        });
        $('#btn-porta-fechar').on('click', function () { $('#painel-porta').hide(); });
        $('#btn-porta-salvar').on('click', salvarPorta);

        $(document).on('keydown', function (ev) {
            if (ev.key === 'Escape') {
                $('#painel-porta, #modal-olt, #modal-dio').hide();
            }
        });
    });
})();
