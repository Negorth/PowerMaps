(function ($) {
    'use strict';
    var capacidadeLinhas = [];
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    }); }
    function chamar(acao, callback, erro) {
        FTTH.chamar({ url: 'operacao.php?ajax=' + acao, onOk: callback,
            onErro: erro || function (m) { FTTH.toast('erro', m); } });
    }
    function carregarCapacidade() {
        $('#op-capacidade-status').text('Carregando capacidade…');
        chamar('capacidade', function (d) {
            capacidadeLinhas = d.linhas || [];
            var regiaoAtual = $('#op-capacidade-regiao').val();
            var regioes = [];
            capacidadeLinhas.forEach(function (r) { if (regioes.indexOf(r.regiao) < 0) regioes.push(r.regiao); });
            regioes.sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
            $('#op-capacidade-regiao').html('<option value="">Todas as regiões</option>' + regioes.map(function (r) {
                return '<option value="' + esc(r) + '">' + esc(r) + '</option>';
            }).join(''));
            if (regioes.indexOf(regiaoAtual) >= 0) $('#op-capacidade-regiao').val(regiaoAtual);
            $('#op-capacidade-status').data('gerado-em', d.gerado_em);
            aplicarFiltroCapacidade();
        });
    }
    function aplicarFiltroCapacidade() {
            var regiao = $('#op-capacidade-regiao').val();
            var termo = $.trim(String($('#op-capacidade-busca').val() || '')).toLocaleLowerCase('pt-BR');
            var rows = capacidadeLinhas.filter(function (r) {
                if (regiao && r.regiao !== regiao) return false;
                var texto = [r.olt, r.pon, r.cto].join(' ').toLocaleLowerCase('pt-BR');
                return !termo || texto.indexOf(termo) >= 0;
            });
            $('#op-capacidade-linhas').html(rows.map(function (r) {
                return '<tr><td>' + esc(r.regiao) + '</td><td>' + esc(r.olt) + '</td><td>' + esc(r.pon)
                    + '</td><td><a href="campo.php?caixa=' + Number(r.caixa_id) + '">' + esc(r.cto) + '</a>'
                    + (!r.capacidade_documentada ? '<small class="ftth-op-secundario">capacidade não documentada</small>' : '')
                    + '</td><td>' + Number(r.fibras_conectadas || 0) + '</td><td>' + Number(r.ocupadas)
                    + '</td><td>' + Number(r.reservadas) + '</td><td>' + Number(r.livres) + '</td><td>' + Number(r.total) + '</td></tr>';
            }).join('') || '<tr><td colspan="9">Nenhuma CTO corresponde aos filtros.</td></tr>');
            var status = $('#op-capacidade-status');
            var momento = status.data('gerado-em');
            status.text(rows.length + ' de ' + capacidadeLinhas.length + ' linhas · atualizado às ' + esc(momento || '—'));
            $('#op-capacidade-csv').prop('disabled', !rows.length);
            return rows;
    }
    function exportarCapacidadeCsv() {
        var linhas = aplicarFiltroCapacidade();
        if (!linhas.length) return;
        function celula(valor) {
            var texto = String(valor == null ? '' : valor);
            if (/^[=+@\-\t\r]/.test(texto)) texto = "'" + texto;
            return '"' + texto.replace(/"/g, '""') + '"';
        }
        var csv = [['Região', 'OLT', 'PON', 'CTO', 'Fibras conectadas', 'Ocupadas', 'Reservadas', 'Livres', 'Total']]
            .concat(linhas.map(function (r) { return [r.regiao, r.olt, r.pon, r.cto, r.fibras_conectadas,
                r.ocupadas, r.reservadas, r.livres, r.total]; }))
            .map(function (linha) { return linha.map(celula).join(';'); }).join('\r\n');
        var url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
        var a = document.createElement('a'); a.href = url; a.download = 'capacidade-ftth.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    function carregarPendencias() {
        $('#op-pendencias-status').text('Revisando dados…');
        chamar('pendencias', function (d) {
            var itens = d.itens || [];
            $('#op-pendencias-status').text(d.quantidade + ' itens para revisar. ' + d.aviso
                + (d.parcial ? ' A lista de vãos foi limitada para manter a consulta rápida.' : ''));
            $('#op-pendencias-lista').html(itens.map(function (i) {
                var link = i.caixa_id ? 'campo.php?caixa=' + Number(i.caixa_id)
                    : (i.vao_id ? 'mapa.php?foco_vao=' + Number(i.vao_id) : '');
                return '<article class="ftth-op-item ' + (i.gravidade === 'alerta' ? 'alerta' : '') + '">'
                    + '<div><strong>' + esc(i.titulo) + '</strong><p>' + esc(i.detalhe) + '</p></div>'
                    + (link ? '<a class="ftth-btn ftth-btn--sec" href="' + link + '">Abrir</a>' : '') + '</article>';
            }).join('') || '<div class="ftth-op-vazio">Nenhuma divergência encontrada nas verificações disponíveis.</div>');
        });
    }
    function carregarVaos() {
        chamar('vaos', function (d) {
            var vaos = d.vaos || [];
            $('#op-vao').html('<option value="">Selecione o trecho</option>' + vaos.map(function (v) {
                return '<option value="' + Number(v.id) + '" data-fibras="' + Number(v.fibras) + '">'
                    + esc(v.regiao + ' · ' + v.cabo + ' · ' + v.inicio + ' → ' + v.fim)
                    + ' (' + Number(v.fibras) + ' FO)</option>';
            }).join(''));
        });
    }
    $(function () {
        $('.ftth-op-abas button').on('click', function () {
            var tab = String($(this).data('tab'));
            $('.ftth-op-abas button').removeClass('ativo').attr('aria-selected', 'false');
            $(this).addClass('ativo').attr('aria-selected', 'true');
            $('.ftth-op-secao').removeClass('ativa');
            $('#op-' + tab).addClass('ativa');
            if (tab === 'capacidade') carregarCapacidade();
            if (tab === 'pendencias') carregarPendencias();
        });
        $('#op-atualizar-capacidade').on('click', carregarCapacidade);
        $('#op-capacidade-regiao').on('change', aplicarFiltroCapacidade);
        $('#op-capacidade-busca').on('input', aplicarFiltroCapacidade);
        $('#op-capacidade-csv').on('click', exportarCapacidadeCsv);
        $('#op-atualizar-pendencias').on('click', carregarPendencias);
        $('#op-vao').on('change', function () {
            var n = Number($(this).find(':selected').data('fibras')) || 1;
            $('#op-fibra').attr('max', n).val(Math.min(Number($('#op-fibra').val()) || 1, n));
        });
        $('#op-simular').on('click', function () {
            var vao = Number($('#op-vao').val()), fibra = Number($('#op-fibra').val());
            if (!vao || !fibra) { FTTH.toast('info', 'Selecione um trecho e uma fibra.'); return; }
            $('#op-impacto-resultado').html('<div class="ftth-op-status">Calculando a rede cadastrada…</div>');
            chamar('impacto&vao=' + encodeURIComponent(vao) + '&fibra=' + encodeURIComponent(fibra), function (d) {
                var html = '<div class="ftth-op-impacto"><div class="ftth-op-kpi"><strong>'
                    + Number(d.clientes_unicos) + '</strong><span>clientes únicos atingidos</span></div>'
                    + '<div class="ftth-op-kpi"><strong>' + Number(d.pontos_atendimento)
                    + '</strong><span>pontos de atendimento</span></div>'
                    + '<div class="ftth-op-kpi"><strong>' + Number(d.clientes_com_caminho_alternativo)
                    + '</strong><span>clientes cuja rota cadastrada usava este trecho e mantêm caminho</span></div></div>'
                    + '<p class="ftth-op-status">' + (d.sem_origem_documentada
                        ? 'Não há origem DIO/OLT documentada; o impacto pode estar subestimado.'
                        : 'Resultado baseado na topologia registrada; confirme a planta e a situação em campo.') + '</p>';
                if (d.ctos && d.ctos.length) html += '<h3>CTOs com saídas sem caminho após a falha</h3><ul>'
                    + d.ctos.map(function (c) { return '<li>' + esc(c.nome) + '</li>'; }).join('') + '</ul>';
                else html += '<div class="ftth-op-vazio">Nenhuma saída de cliente perdeu o caminho documentado neste cenário.</div>';
                $('#op-impacto-resultado').html(html);
            });
        });
        carregarCapacidade(); carregarVaos();
    });
}(jQuery));
