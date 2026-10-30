/* ftth_doc :: mapa (Google Maps).
 *
 * Carrega por área visível com margem, reutilizando os marcadores durante pequenos deslocamentos.
 * Itens em quarentena vêm translúcidos — são "não revisados" e não fazem parte da rede ainda.
 */
(function () {
    'use strict';

    var mapa, infoAtual = null, otdrMarcador = null, otdrInfo = null, otdrFaixa = null, otdrPreviewActive = false;
    var callbackPontoViabilidade = null;
    var marcadores = [], marcadoresClientes = [], linhas = [], quarentenaObj = [], alcasPontasMover = [];
    var clientesMapaDados = [];
    // Camadas por usuário, gravadas no banco (Ajustes::camadas): a página já nasce com elas.
    var camadas = $.extend({ CTO: true, CEO: true, DC: true, PREDIO: true, PROBLEMA: true, RESERVA: true,
                              POSTES: true, CLIENTES: true, CABOS: true, QUARENTENA: true, ROTULOS: true },
                            (window.FTTH_MAPA || {}).camadas || {});
    var esperando = null, regiao = 0;
    var areaCarregada = null, requisicaoMapa = 0, requisicaoClientes = 0;
    var rotulosGoogle = null;
    var modo = 'navegar';                       // navegar | caixa
    var pontosMedicao = [], marcadoresMedicao = [], linhaMedicao = null;
    var vaoAtivoMoverId = null;                  // só este vão recebe alças de edição
    var linhaAtivaMover = null;
    var marcadorVerticeRotaMover = null;
    var temporizadorFocoVerticeRotaMover = null;
    var pontaSelecionadaMover = null;            // {vao, lado, previa}: ponta aguardando CTO/destino
    var vinculoMeioMover = null;                 // {vao, caboNome, salvando}: caixa existente no meio do cabo
    var pontoNovo = null;                       // onde o usuário marcou o pin
    var pinTemporario = null;                   // marcador provisório mostrando esse ponto
    var editando = null;                        // {id, versao} quando o modal está editando
    var tracado = [];                           // pontos do cabo sendo desenhado
    var linhaTracado = null, pinosTracado = [];  // desenho provisório
    var caboAberto = null;                       // vão cuja ficha está aberta no painel

    // Primeiros passos (js/onboarding.js). O assistente não mexe no mapa por dentro: ele pede
    // pelo FTTH_MAPA_API e escuta o evento 'ftth:mudou', disparado a cada mudança de estado.
    var presetPonto = null;      // {tipo, nome}: o próximo ponto já nasce com tipo e nome
    var caboDesde = null;        // caixa em que o próximo traçado começa sozinho
    var continuando = null;      // {ponta, nome, tipo, cor}: "Continuar cabo" da ponta livre
    var pontoEmDestaque = 0;     // marcador que pula: o destino do primeiro cabo
    // O que a rede já tem, para travar o que ainda não faz sentido (sem POP: só POP, e sem
    // cabo). Vale para qualquer usuário, com ou sem o assistente na tela.
    var travas = { pop: true };
    // Modo Mover: nada vai para o banco antes do Concluir (decisão de 22/09/2026).
    var pendentes = { caixas: {}, vaos: {} };
    var ultimoDesenho = null;                    // último payload, para saber quem toca quem
    // Modo Selecionar: a área sendo desenhada e, depois do Concluir, a prévia do servidor.
    var areaSel = [];                            // vértices da área (google.maps.LatLng)
    var areaPoligono = null, areaPinos = [];     // desenho provisório da área
    var selecao = null;                          // Lote::previa — o que sai se excluir
    var selAneis = [];                           // anel em volta de cada ponto selecionado

    // Ordem de empilhamento no mapa. A caixa por cima do cabo não é estética: é o que faz o
    // clique cair no marcador, e não na alça de edição que o Google desenha no mesmo ponto.
    var Z_QUARENTENA = 2;   // o que ainda não é rede fica por baixo do que já é
    var Z_CABO = 10;
    var Z_CAIXA = 500;
    var Z_CAIXA_ARRASTANDO = 600;

    /** Lado do marcador no mapa, em px. O desenho continua num viewBox de 24. */
    var PX_ICONE = 30;

    /*
     * Os seis tipos do seletor usam a silhueta da peça real (Caixa::SILHUETAS, no PHP).
     * A `forma` aqui só vale para os tipos legados — poste, cliente e CTO AP saíram do
     * menu mas continuam válidos, e caixas antigas precisam de ícone para aparecer.
     * A cor é apenas o padrão de quando a caixa não tem uma própria.
     */
    var ICONES = {
        CTO:      { forma: 'cto', cor: '#00C853' },
        CEO:      { forma: 'ceo', cor: '#FF9100' },
        DC:       { forma: 'estrela', cor: '#1B3A6B' },
        PREDIO:   { forma: 'quadrado', cor: '#6A1B9A' },
        POSTE:    { forma: 'circulo', cor: '#FF9100' },
        CTO_AP:   { forma: 'quadrado', cor: '#00ACC1' },
        CLIENTE:  { forma: 'gota', cor: '#2962FF' },
        RESERVA:  { forma: 'losango', cor: '#9E9E9E' },
        PROBLEMA: { forma: 'triangulo', cor: '#D50000' },
        FALHA:    { forma: 'triangulo', cor: '#D50000' }
    };

    /** Classe de ícone (Bootstrap Icons do painel) usada nos textos da ficha. */
    var ICONE_CLASSE = {
        DC: 'bi-hdd-rack-fill', PREDIO: 'bi-building', POSTE: 'bi-signpost-2-fill',
        CEO: 'bi-diagram-3-fill', CLIENTE: 'bi-person-fill', CTO: 'bi-box-seam',
        CTO_AP: 'bi-buildings-fill', PROBLEMA: 'bi-exclamation-triangle-fill',
        RESERVA: 'bi-bookmark-fill', FALHA: 'bi-exclamation-octagon-fill', PONTA: 'bi-record-circle'
    };

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/[&<>"]/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
            });
    }

    /** Ícone em SVG: sem depender de arquivo de imagem nem de CDN. */
    function icone(tipo, cor, opaco) {
        var cfg = ICONES[tipo] || ICONES.CTO;
        var c = cor || cfg.cor;
        if (tipo === 'CTO' || tipo === 'CTO_AP') c = '#000000';
        var op = opaco === false ? 0.45 : 1;
        var corpo;
        // A silhueta vem do PHP (Caixa::SILHUETAS), para o mapa, a ficha e o seletor de
        // tipo desenharem a partir da MESMA fonte. Só a cor é trocada aqui.
        var silhuetas = (window.FTTH_MAPA || {}).silhuetas || {};
        if (silhuetas[tipo]) {
            corpo = silhuetas[tipo].split('{cor}').join(c);
        } else if (cfg.forma === 'quadrado') {
            corpo = '<rect x="4" y="4" width="16" height="16" rx="3" fill="' + c + '" stroke="#fff" stroke-width="2"/>';
        } else if (cfg.forma === 'triangulo') {
            corpo = '<path d="M12 3 L21 20 L3 20 Z" fill="' + c + '" stroke="#fff" stroke-width="2"/>';
        } else if (cfg.forma === 'losango') {
            corpo = '<path d="M12 3 L21 12 L12 21 L3 12 Z" fill="' + c + '" stroke="#fff" stroke-width="2"/>';
        } else if (cfg.forma === 'gota') {
            corpo = '<path d="M12 2 C16 6 19 9 19 13 a7 7 0 0 1 -14 0 c0 -4 3 -7 7 -11 z" fill="' + c
                  + '" stroke="#fff" stroke-width="1.8"/>';
        } else if (cfg.forma === 'estrela') {
            corpo = '<path d="M12 2 l3 6 6 1 -4.5 4.5 1 6.5 -5.5 -3 -5.5 3 1 -6.5 L3 9 l6 -1 z" fill="' + c + '" stroke="#fff" stroke-width="1.5"/>';
        } else {
            corpo = '<circle cx="12" cy="12" r="8" fill="' + c + '" stroke="#fff" stroke-width="2"/>';
        }
        // 30px em vez de 24: a silhueta tem detalhe (o anel da CEO, a trava da CTO) que
        // no tamanho antigo virava um risco só. O viewBox continua 0 0 24 24 — muda a
        // apresentação, não o desenho.
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"'
                + ' width="' + PX_ICONE + '" height="' + PX_ICONE + '" opacity="' + op + '">'
                + corpo + '</svg>';
        return {
            url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
            scaledSize: new google.maps.Size(PX_ICONE, PX_ICONE),
            anchor: new google.maps.Point(PX_ICONE / 2, PX_ICONE / 2),
            // O rótulo sai de cima do desenho e vai para ACIMA dele: centrado no ícone,
            // o nome cobria justamente a silhueta que ele deveria ajudar a identificar.
            // labelOrigin é medido a partir do canto superior esquerdo do ícone, então
            // um y negativo o joga para fora, acima da peça.
            labelOrigin: new google.maps.Point(PX_ICONE / 2, -7)
        };
    }

    /**
     * Ponta livre de cabo: bolinha branca com o aro na cor do cabo. Pequena de propósito —
     * não é uma peça da rede, é o lugar onde uma peça ainda vai entrar.
     */
    function iconePonta(cor) {
        return { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#FFFFFF', fillOpacity: 1,
                 strokeColor: cor || '#00E676', strokeWeight: 3 };
    }

    function limpar() {
        marcadores.forEach(function (m) { m.setMap(null); });
        if (linhaAtivaMover) restaurarEstiloVaoMover(linhaAtivaMover);
        ocultarPainelRotaMover();
        linhas.forEach(function (l) { l.setMap(null); });
        quarentenaObj.forEach(function (q) { q.setMap(null); });
        alcasPontasMover.forEach(function (m) { m.setMap(null); });
        marcadores = []; linhas = []; quarentenaObj = []; alcasPontasMover = [];
        $('#mover-vinculo-abrir').hide();
        linhaAtivaMover = null;              // o id continua para reativar após redesenhar
    }

    function limparMarcadoresClientes() {
        marcadoresClientes.forEach(function (m) { m.setMap(null); });
        marcadoresClientes = [];
    }

    /** Pinos próprios para conta normal, adicional e bloqueada; o ponto verde/laranja
     * preserva a informação de vínculo FTTH que antes era comunicada pela cor do círculo. */
    function iconeClienteMapa(tipoConta, bloqueado, vinculado) {
        var cor = bloqueado ? '#C62828'
            : tipoConta === 'adicional' ? '#7447B8'
            : tipoConta === 'instalacao' ? '#E58A19' : '#1676C5';
        var desenho;
        if (bloqueado) {
            desenho = '<path d="M14 19v-3a6 6 0 0 1 12 0v3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'
                + '<rect x="12" y="19" width="16" height="12" rx="2.5" fill="#fff"/>'
                + '<circle cx="20" cy="24" r="1.4" fill="' + cor + '"/><path d="M20 25v2" stroke="' + cor + '" stroke-width="1.5"/>';
        } else if (tipoConta === 'adicional') {
            desenho = '<circle cx="17" cy="15" r="4" fill="#fff"/>'
                + '<path d="M9 27c.5-4.5 3.5-7 8-7 2 0 3.6.5 4.8 1.5" fill="#fff"/>'
                + '<circle cx="26" cy="24" r="6" fill="#fff"/><path d="M26 21v6M23 24h6" stroke="' + cor + '" stroke-width="2" stroke-linecap="round"/>';
        } else if (tipoConta === 'instalacao') {
            desenho = '<path d="m11 19 9-7 9 7v10H11z" fill="#fff" stroke="#fff" stroke-linejoin="round"/>'
                + '<path d="M18 29v-6h5v6" fill="' + cor + '"/>';
        } else {
            desenho = '<circle cx="20" cy="15" r="5" fill="#fff"/>'
                + '<path d="M10 29c.6-5.3 4-8 10-8s9.4 2.7 10 8" fill="#fff"/>';
        }
        var dot = tipoConta !== 'adicional' && tipoConta !== 'instalacao'
            ? '<circle cx="32" cy="31" r="5" fill="' + (vinculado ? '#16A36A' : '#E58A19')
                + '" stroke="#fff" stroke-width="2"/>' : '';
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 48" width="40" height="48">'
            + '<path d="M20 1C9.5 1 2 8.8 2 18.5 2 30 20 47 20 47s18-17 18-28.5C38 8.8 30.5 1 20 1z" fill="'
            + cor + '" stroke="#fff" stroke-width="2"/>'
            + '<circle cx="20" cy="19" r="13" fill="rgba(0,0,0,.12)"/>'
            + desenho + dot + '</svg>';
        return {
            url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
            scaledSize: new google.maps.Size(32, 38),
            anchor: new google.maps.Point(16, 36),
            labelOrigin: new google.maps.Point(16, -5)
        };
    }

    function desenharClientesMapa(lista) {
        clientesMapaDados = lista || [];
        limparMarcadoresClientes();
        if (!camadas.CLIENTES || modo !== 'navegar') return;
        clientesMapaDados.forEach(function (c) {
            if (c.lat === null || c.lng === null || c.lat === undefined || c.lng === undefined) return;
            var tipoConta = c.tipo_conta || (c.instalacao_id ? 'instalacao' : 'normal');
            var bloqueado = !!c.bloqueado;
            var status = bloqueado ? (tipoConta === 'adicional' ? 'Cliente adicional bloqueado' : 'Cliente bloqueado')
                : tipoConta === 'adicional' ? 'Cliente adicional'
                : tipoConta === 'instalacao' ? 'Ponto de instalação adicional' : 'Cliente normal';
            var m = new google.maps.Marker({
                position: { lat: Number(c.lat), lng: Number(c.lng) },
                map: mapa,
                title: status + ' · ' + c.login + (c.identificacao ? ' · ' + c.identificacao : '')
                    + (c.ja_em ? ' · ' + c.ja_em : ''),
                clickable: true,
                zIndex: bloqueado ? 42 : tipoConta === 'adicional' ? 32 : 20,
                icon: iconeClienteMapa(tipoConta, bloqueado, !!c.ja_em),
                label: mapa.getZoom() >= 18 ? {
                    text: c.identificacao || c.login, fontSize: '10px', color: '#17324D',
                    className: 'ftth-rotulo-cliente'
                } : null
            });
            m.addListener('click', function () {
                if (modo === 'navegar') abrirClienteMapa(Number(c.cliente_id), c.instalacao_id || null, {
                    tipo: tipoConta, login: c.login, nome: c.nome, bloqueado: bloqueado
                });
            });
            marcadoresClientes.push(m);
        });
    }

    function visivel(tipo) {
        if (tipo === 'CTO' || tipo === 'CTO_AP') return camadas.CTO;
        if (tipo === 'PONTA') return camadas.CABOS;   // a ponta livre é do cabo, e some com ele
        if (tipo === 'POSTE') return camadas.POSTES;
        if (tipo === 'FALHA') return camadas.PROBLEMA;
        if (tipo === 'CLIENTE') return camadas.PREDIO;  // tipo legado, sem camada própria
        return camadas[tipo] !== false;
    }

    // Os tipos de ponto (Caixa::TIPOS). O modo Selecionar manda só os visíveis: camada
    // desligada esconde o ponto E tira ele da seleção — antes a Cor pintava o que estava
    // escondido (produção, 01/10/2026). A ponta livre fica de fora: ela é do cabo, e o cabo
    // entra inteiro pela camada Cabos (com_cabos).
    var TIPOS_PONTO = ['DC', 'PREDIO', 'POSTE', 'CEO', 'CTO', 'CTO_AP', 'CLIENTE', 'RESERVA',
                       'PROBLEMA', 'FALHA'];
    var CAMADAS_PONTO = [['CTO', 'CTO'], ['CEO', 'CEO'], ['DC', 'DC / POP'], ['PREDIO', 'Prédio'],
                         ['PROBLEMA', 'Problema'], ['RESERVA', 'Reserva'], ['POSTES', 'Postes']];

    /**
     * A ficha abriu (lista de Pontos, busca) e o mapa centralizou num ponto cuja camada está
     * desligada: sem o aviso, o usuário fica procurando um marcador que não está lá.
     */
    function avisarCamadaOculta(tipo) {
        if (!tipo || visivel(tipo)) return;
        var nome = { CTO: 'CTO', CTO_AP: 'CTO', CEO: 'CEO', DC: 'DC / POP', PREDIO: 'Prédio',
                     CLIENTE: 'Prédio', PROBLEMA: 'Problema', FALHA: 'Problema', RESERVA: 'Reserva',
                     POSTE: 'Postes', PONTA: 'Cabos' }[tipo] || tipo;
        FTTH.toast('info', 'A camada ' + nome + ' está desligada: o ponto não aparece no mapa. '
            + 'Ligue-a na aba Camadas.');
    }

    function tiposVisiveis() {
        return TIPOS_PONTO.filter(visivel);
    }

    /** O aviso amarelo dos cards do Selecionar: só aparece com camada de ponto desligada. */
    function avisarFiltroSelecao() {
        var todas = CAMADAS_PONTO.concat([['CABOS', 'Cabos']]);
        var ligadas = todas.filter(function (c) { return camadas[c[0]]; });
        var txt = '';
        if (!ligadas.length) {
            txt = 'Nenhuma camada de ponto ou cabo ligada: nada entra na seleção.';
        } else if (ligadas.length < todas.length) {
            txt = 'Só camadas visíveis: ' + ligadas.map(function (c) { return c[1]; }).join(', ') + '.';
        }
        $('.ftth-sel-filtro').text(txt);
    }

    /**
     * Pede a área visível com margem. `soArea` vem do arrasto/zoom: aí nada na
     * rede mudou. Sem ele a chamada vem de uma alteração (criar, mover, excluir), e a lista
     * de pontos do painel também fica velha.
     */
    function areaVisivelDentroDaCarregada(bounds, quarentena) {
        return !!areaCarregada
            && areaCarregada.regiao === regiao
            && areaCarregada.quarentena === quarentena
            && areaCarregada.bounds.contains(bounds.getNorthEast())
            && areaCarregada.bounds.contains(bounds.getSouthWest());
    }

    /** Pede uma margem ao redor da tela; pequenas movimentações reaproveitam os marcadores. */
    function ampliarArea(bounds) {
        var ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
        var folgaLat = Math.max(0.001, (ne.lat() - sw.lat()) * 0.35);
        var folgaLng = Math.max(0.001, (ne.lng() - sw.lng()) * 0.35);
        return new google.maps.LatLngBounds(
            new google.maps.LatLng(Math.max(-90, sw.lat() - folgaLat), Math.max(-180, sw.lng() - folgaLng)),
            new google.maps.LatLng(Math.min(90, ne.lat() + folgaLat), Math.min(180, ne.lng() + folgaLng))
        );
    }

    function bboxDaArea(bounds) {
        var ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
        return [sw.lat(), sw.lng(), ne.lat(), ne.lng()].map(function (n) {
            return Number(n.toFixed(6));
        }).join(',');
    }

    function carregar(soArea) {
        if (!mapa || !regiao) return;
        if (!soArea) {
            clearTimeout(esperando);
            esperando = null;
            areaCarregada = null;
            requisicaoMapa++;
            requisicaoClientes++;
            recarregarPontos();
            avisarMudanca();
        }
        var b = mapa.getBounds();
        if (!b) return;
        var quarentena = !!camadas.QUARENTENA;
        if (soArea && areaVisivelDentroDaCarregada(b, quarentena)) {
            requisicaoMapa++;
            return;
        }
        var boundsCarregados = ampliarArea(b);
        var bbox = bboxDaArea(boundsCarregados);
        var token = ++requisicaoMapa;
        var tokenClientes = ++requisicaoClientes;
        var regiaoSolicitada = regiao;

        FTTH.chamar({
            url: 'mapa.php?ajax=elementos&regiao=' + regiao + '&bbox=' + bbox
                 + '&quarentena=' + (quarentena ? 1 : 0),
            onOk: function (d) {
                if (token !== requisicaoMapa || regiaoSolicitada !== regiao) return;
                areaCarregada = d.truncado ? null
                    : { regiao: regiaoSolicitada, bounds: boundsCarregados, quarentena: quarentena };
                desenhar(d);
            },
            onErro: function (m) {
                if (token === requisicaoMapa && regiaoSolicitada === regiao) $('#resumo-mapa').text(m);
            }
        });
        if (camadas.CLIENTES) {
            FTTH.chamar({
                url: 'mapa.php?ajax=clientes_mapa&regiao=' + regiao + '&bbox=' + bbox,
                onOk: function (d) {
                    if (tokenClientes === requisicaoClientes && regiaoSolicitada === regiao) {
                        desenharClientesMapa(d.clientes || []);
                    }
                },
                onErro: function () {
                    if (tokenClientes === requisicaoClientes && regiaoSolicitada === regiao) {
                        areaCarregada = null;
                        desenharClientesMapa([]);
                    }
                }
            });
        } else {
            desenharClientesMapa([]);
        }
    }

    /** Algo mudou na rede ou no modo: quem acompanha (os primeiros passos) confere de novo. */
    function avisarMudanca() {
        $(document).trigger('ftth:mudou');
    }

    /**
     * Botão de modo que ainda não faz sentido fica apagado com o motivo, e o clique diz o
     * motivo em vez de não fazer nada. Não usa `disabled`: botão desabilitado não recebe
     * clique nem mostra a dica em todo navegador, e aí o usuário não descobre o porquê.
     */
    function aplicarTravas() {
        var semRegiao = regiao ? '' : 'Crie uma região primeiro: é nela que os pontos ficam.';
        var motivos = {
            caixa: semRegiao,
            mover: semRegiao,
            selecionar: semRegiao,
            // Desde a 0.9.6 o cabo pode terminar numa ponta livre: não precisa de duas caixas,
            // mas continua saindo do POP — sem ele, não há de onde puxar o primeiro cabo.
            cabo:  semRegiao || (!travas.pop ? 'Marque o POP antes: é dele que as fibras saem.' : '')
        };
        $.each(motivos, function (m, motivo) {
            $('.ftth-modo[data-modo="' + m + '"]')
                .toggleClass('bloqueado', !!motivo)
                .attr('aria-disabled', motivo ? 'true' : 'false')
                .attr('title', motivo);
        });
    }

    /** Escolhe o tipo no modal do ponto e atualiza o pino que já está no mapa. */
    function selecionarTipo(tipo) {
        $('.ftth-tipo').removeClass('ativo').filter('[data-tipo="' + tipo + '"]').addClass('ativo');
        camposDoTipo();
        if (pinTemporario) pinTemporario.setIcon(icone(tipoSelecionado(), corSelecionada(), true));
    }

    /**
     * Sem POP na rede, o único ponto que se cria é o POP: é dele que as fibras saem, e começar
     * pela CTO deixa o técnico sem ter de onde puxar o primeiro cabo. A edição não trava nada.
     */
    function aplicarTravaTipos() {
        var soPop = !editando && !travas.pop;
        $('.ftth-tipo').not('[data-tipo="DC"]').prop('disabled', soPop);
        $('#nc-trava').toggle(soPop);
        if (soPop && tipoSelecionado() !== 'DC') selecionarTipo('DC');
    }

    /** O número no botão diz o que está ligado sem precisar abrir o menu. */
    function atualizarContaCamadas() {
        $('#camadas-conta').text($('.cam:checked').length);
        // Tudo marcado: o botão do título desmarca; faltando alguma, ele marca.
        $('#cam-todas').text($('.cam:not(:checked)').length ? 'Marcar todos' : 'Desmarcar todos');
    }

    function estilosGoogle() {
        var estilos = [
            { featureType: 'poi',     stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] }
        ];
        if (camadas.ROTULOS === false) {
            estilos.push({ featureType: 'road', elementType: 'labels',
                           stylers: [{ visibility: 'off' }] });
        }
        return estilos;
    }

    /** Aplica o controle de nomes de rua no mapa de ruas e no overlay do satélite. */
    function atualizarRotulosGoogle() {
        if (!mapa) return;
        mapa.setOptions({ styles: estilosGoogle() });
        if (!rotulosGoogle) return;

        var overlays = mapa.overlayMapTypes;
        var indice = -1;
        for (var i = 0; i < overlays.getLength(); i++) {
            if (overlays.getAt(i) === rotulosGoogle) { indice = i; break; }
        }
        var mostrar = camadas.ROTULOS !== false && mapa.getMapTypeId() === 'satellite';
        if (mostrar && indice < 0) overlays.insertAt(0, rotulosGoogle);
        else if (!mostrar && indice >= 0) overlays.removeAt(indice);
    }

    /** Camada mudou: redesenha e grava na hora (fechar a página não pode devolver a camada). */
    function camadasMudaram(camada) {
        atualizarContaCamadas();
        if (camada === 'ROTULOS' || camada === 'TODAS') atualizarRotulosGoogle();
        if (camada !== 'ROTULOS') {
            carregar();
            if (modo === 'selecionar') camadaNaSelecao();
        }
        FTTH.chamar({
            url: 'mapa.php?ajax=camadas',
            method: 'POST',
            data: { csrf: (window.FTTH_MAPA || {}).csrf, camadas: JSON.stringify(camadas) },
            onErro: function (m) { FTTH.toast('erro', 'A camada não foi gravada: ' + m); }
        });
    }

    function desenhar(d) {
        limpar();
        // Filtro da aba Pontos: o que não atende fica translúcido — some do foco, não do mapa.
        var destaque = idsDoFiltro();
        ultimoDesenho = d;   // o modo Mover precisa saber que cabos tocam cada caixa

        d.caixas.forEach(function (c) {
            if (!visivel(c.tipo)) return;
            // No modo Mover a posição que vale é a pendente, senão a caixa voltaria para
            // o lugar antigo a cada recarga da área visível.
            var pend = pendentes.caixas[c.id];
            var m = new google.maps.Marker({
                position: pend
                    ? { lat: pend.lat, lng: pend.lng }
                    : { lat: parseFloat(c.lat), lng: parseFloat(c.lng) },
                map: mapa,
                icon: c.tipo === 'PONTA' ? iconePonta(c.cor)
                    : icone(c.tipo, c.tipo === 'CTO' || c.tipo === 'CTO_AP' ? '#000000' : c.cor, true),
                title: c.nome,
                draggable: modo === 'mover',
                // A caixa fica SEMPRE acima do cabo e das alças de edição dele. As alças
                // do Google nascem no centro da caixa, e sem isto o clique pegava a alça em
                // vez do marcador: o técnico arrastava a ponta do cabo achando que estava
                // arrastando a caixa.
                zIndex: pend ? Z_CAIXA_ARRASTANDO : Z_CAIXA,
                opacity: destaque && !destaque[c.id] ? 0.3 : 1,
                label: c.tipo !== 'PONTA' && mapa.getZoom() >= ((window.FTTH_MAPA || {}).rotulo_zoom || 17)
                    ? { text: c.nome, fontSize: '11px', color: '#22303F', className: 'ftth-rotulo' }
                    : null
            });
            // O destino do primeiro cabo pula enquanto o traçado não chega nele.
            if (pontoEmDestaque && Number(c.id) === pontoEmDestaque && !destinoAlcancado()) {
                m.setAnimation(google.maps.Animation.BOUNCE);
            }
            m.addListener('click', function () {
                if (modo === 'medir') {
                    adicionarPontoMedicao(m.getPosition());
                    return;
                }
                if (modo === 'mover' && vinculoMeioMover) {
                    vincularMeioAoObjetoMover(c);
                    return;
                }
                if (modo === 'mover' && pontaSelecionadaMover) {
                    vincularPontaMover(c);
                    return;
                }
                // No modo Cabo, clicar numa caixa ancora o traçado nela em vez de abrir a ficha.
                if (modo === 'cabo') {
                    // Reserva não é ponta de cabo: ela nasce no meio de um cabo já lançado.
                    if (c.tipo === 'RESERVA') {
                        FTTH.toast('erro', 'Reserva não recebe cabo: ela fica no meio de um cabo já lançado.');
                        return;
                    }
                    // Poste: o cabo PASSA por ele — vira vértice no lugar exato do poste.
                    if (c.tipo === 'POSTE') {
                        pontoTracado({ tipo: 'VERTICE', lat: parseFloat(c.lat), lng: parseFloat(c.lng) });
                        return;
                    }
                    pontoTracado({ tipo: 'CAIXA', id: parseInt(c.id, 10), nome: c.nome,
                                   lat: parseFloat(c.lat), lng: parseFloat(c.lng) });
                    return;
                }
                if (modo === 'mover') return;     // no modo Mover o clique é para arrastar
                if (modo === 'selecionar') {
                    cliqueSelecionar(c, m.getPosition());
                    return;
                }
                abrirFicha(c.id);
            });
            if (modo === 'mover') {
                // A ponta dos cabos acompanha na tela enquanto se arrasta; no banco quem
                // faz isso é o Caixa::mover, na hora do Concluir.
                m.addListener('dragstart', function () {
                    if (pontaSelecionadaMover) {
                        limparSelecaoPontaMover();
                        var selecionada = (ultimoDesenho && ultimoDesenho.vaos || []).filter(function (x) {
                            return Number(x.id) === Number(vaoAtivoMoverId);
                        })[0];
                        if (selecionada) desenharAlcasPontasMover(selecionada);
                    }
                });
                m.addListener('drag', function (ev) {
                    pendentes.caixas[c.id] = { lat: ev.latLng.lat(), lng: ev.latLng.lng(),
                                               nome: c.nome, tipo: c.tipo };
                    arrastarPontasNaTela(c.id);
                });
                m.addListener('dragend', function () {
                    atualizarContaMover();
                    // Vínculos são sempre uma ação explícita nas alças da rota selecionada.
                });
            }
            m.ftthCaixaId = Number(c.id);   // para o modo Selecionar achar o ponto
            marcadores.push(m);
        });

        if (modo === 'mover') {
            $('#mover-dica').text('Selecione um cabo. Use as pontas para conectar ou soltar; para ligar uma CTO no meio, use “Vincular ponto no trecho”.');
        }

        if (camadas.CABOS || otdrPreviewActive) {
            d.vaos.forEach(function (v) {
                // pontosDoVao é quem sabe montar o traçado de verdade: ele aplica o vértice
                // arrastado à mão E a ponta da caixa que está sendo movida. Desenhar direto de
                // v.vertices fazia o cabo voltar para o lugar antigo a cada zoom, enquanto a
                // caixa ficava onde o técnico soltou.
                var pts = pontosDoVao(v);
                if (pts.length < 2) return;
                var caminho = pts.map(function (p) { return { lat: p[0], lng: p[1] }; });
                var espessura = parseInt(v.espessura_mapa, 10);
                if (isNaN(espessura) || espessura < 1 || espessura > 12) {
                    espessura = parseInt((window.FTTH_MAPA || {}).cabo_espessura, 10) || 5;
                }
                var configMapa = window.FTTH_MAPA || {};
                var idDestaque = configMapa.otdr ? configMapa.otdr.vao_id
                    : (configMapa.foco_vao ? configMapa.foco_vao.id : 0);
                var destacarOtdr = !!idDestaque && Number(idDestaque) === Number(v.id);
                var l = new google.maps.Polyline({
                    path: caminho, map: mapa,
                    strokeColor: destacarOtdr ? '#FF1744' : (v.cor_rota || '#00E676'),
                    strokeWeight: destacarOtdr ? Math.max(espessura + 3, 8) : espessura,
                    strokeOpacity: destacarOtdr ? 1 : (destaque ? 0.35 : 0.95),
                    cursor: cursorDoCabo(),
                    zIndex: destacarOtdr ? Z_CABO + 2 : Z_CABO
                });
                l.ftthVaoId = v.id;      // para o modo Mover achar a linha deste vão
                l.ftthCor = destacarOtdr ? '#FF1744' : (v.cor_rota || '#00E676');
                l.ftthPeso = destacarOtdr ? Math.max(espessura + 3, 8) : espessura;
                l.ftthOpacidade = destacarOtdr ? 1 : (destaque ? 0.35 : 0.95);
                l.addListener('click', function (e) {
                    if (modo === 'medir') {
                        if (e && e.latLng) adicionarPontoMedicao(e.latLng);
                        return;
                    }
                    if (modo === 'mover') {
                        if (vinculoMeioMover) {
                            FTTH.toast('info', 'Escolha uma CTO ou CEO no mapa, ou cancele o vínculo atual.');
                            return;
                        }
                        var jaSelecionado = Number(vaoAtivoMoverId) === Number(v.id);
                        if (jaSelecionado) {
                            var semVertice = !e || e.vertex === undefined || e.vertex === null;
                            var desfezAlcaIntermediaria = restaurarCliqueNaAlcaIntermediaria(l, v, e);
                            if (desfezAlcaIntermediaria || semVertice) {
                                iniciarVinculoMeioMover(v);
                                return;
                            }
                        }
                        selecionarVaoMover(l, v);
                        return;
                    }
                    // Nos modos de desenho, clicar no cabo é clicar no mapa: a polilinha tem
                    // 5 px de espessura e engolia o clique, abrindo a ficha do cabo bem na
                    // hora em que o técnico queria marcar uma caixa em cima dele.
                    // Com a seleção já feita, o clique no cabo tira ou põe ele inteiro.
                    if (modo === 'selecionar' && selecao) {
                        cliqueCaboSelecionar(v.cabo_id);
                        return;
                    }
                    if (modo === 'caixa' || modo === 'cabo' || modo === 'selecionar' || modo === 'medir') {
                        cliqueNoMapa(e);
                        return;
                    }
                    abrirCabo(v, e.latLng);
                });
                if (modo === 'mover' && Number(vaoAtivoMoverId) === Number(v.id)) {
                    selecionarVaoMover(l, v);
                }
                linhas.push(l);
            });
        }

        if (otdrMarcador) otdrMarcador.setMap(mapa);

        if (camadas.QUARENTENA) {
            (d.quarentena || []).forEach(function (q) {
                if (q.tipo === 'CAIXA') {
                    var m = new google.maps.Marker({
                        position: { lat: parseFloat(q.geo[0][0]), lng: parseFloat(q.geo[0][1]) },
                        map: mapa,
                        icon: icone(q.subtipo, q.cor, false),
                        title: (q.nome || '') + ' — não revisado',
                        zIndex: Z_QUARENTENA
                    });
                    m.addListener('click', function () {
                        if (modo === 'medir') {
                            adicionarPontoMedicao(m.getPosition());
                            return;
                        }
                        abrirQuarentena(q);
                    });
                    quarentenaObj.push(m);
                } else {
                    var caminho = q.geo.map(function (p) {
                        return { lat: parseFloat(p[0]), lng: parseFloat(p[1]) };
                    });
                    if (caminho.length < 2) return;
                    var l = new google.maps.Polyline({
                        path: caminho, map: mapa,
                        strokeColor: q.cor || '#9E9E9E',
                        strokeWeight: (window.FTTH_MAPA || {}).cabo_espessura_q || 4,
                        strokeOpacity: 0.4,
                        zIndex: Z_QUARENTENA
                    });
                    l.addListener('click', function (e) {
                        if (modo === 'medir') {
                            if (e && e.latLng) adicionarPontoMedicao(e.latLng);
                            return;
                        }
                        abrirQuarentena(q);
                    });
                    quarentenaObj.push(l);
                }
            });
        }

        var c = d.contadores || {};
        var item = function (valor, rotulo, extra) {
            return '<span class="ftth-resumo-item' + (extra || '') + '">'
                 + '<b>' + valor + '</b>' + rotulo + '</span>';
        };
        $('#resumo-mapa').html(
            item(d.caixas.length, 'pontos')
            + item(d.vaos.length, 'vãos')
            // Filtro ligado: quantos dos pontos na tela ele destaca — o lembrete de que há filtro.
            + (destaque ? item(d.caixas.filter(function (x) { return destaque[x.id]; }).length,
                               ROTULO_FILTRO[filtroPontos], ' ftth-resumo-item--pend') : '')
            + (c.pendentes ? item(c.pendentes, 'a revisar', ' ftth-resumo-item--pend') : '')
            + (d.truncado
                ? '<span class="ftth-resumo-item ftth-resumo-item--aviso">'
                  + '<i class="bi-exclamation-triangle-fill"></i>&nbsp;parcial: aproxime o mapa</span>'
                : '')
        );
        destacarSelecao();
    }

    function painel(html) {
        $('#painel-conteudo').html(html);
        $('#painel').show();
    }

    /**
     * Ficha da caixa no formato do UpperX: identificação, dados do circuito, ações.
     * O que ainda não existe aparece como "—" e o botão fica desligado com o motivo —
     * melhor do que esconder e deixar o usuário procurando.
     */
    function abrirFicha(id) {
        var cfg = window.FTTH_MAPA || {};
        caboAberto = null;   // daqui em diante o painel fala de uma caixa, não do cabo
        FTTH.chamar({
            url: 'mapa.php?ajax=ficha&id=' + id,
            onOk: function (c) {
                avisarCamadaOculta(c.tipo);
                if (c.tipo === 'RESERVA') {
                    painel(fichaReserva(c));
                    return;
                }
                if (c.tipo === 'PONTA') {
                    painel(fichaPonta(c));
                    return;
                }
                if (c.tipo === 'POSTE') {
                    painel(fichaPoste(c));
                    return;
                }
                var ocupadas = c.clientes.length;
                var portas = 0;
                c.splitters.forEach(function (s) { if (s.funcao === 'ATENDIMENTO') portas += parseInt(s.saidas, 10); });
                var pct = portas ? Math.round(ocupadas * 100 / portas) : 0;

                var selo = c.status === 'certificada'
                    ? '<span class="ftth-selo ftth-selo--ok">certificada</span>'
                    : (c.ligacoes > 0
                        ? '<span class="ftth-selo ftth-selo--info">' + c.ligacoes + ' ligações</span>'
                        : '<span class="ftth-selo ftth-selo--pend">sem diagrama</span>');

                var alimentacao = c.cabos.length
                    ? c.cabos.map(function (v) { return esc(v.sentido); }).join(', ')
                    : '—';
                var splitterLocal = portas
                    ? portas + ' portas (' + c.splitters.map(function (s) { return esc(s.razao); }).join(', ') + ')'
                    : '—';

                var quem = c.alterado_por || c.criado_por || '—';
                var quando = c.alterado_em || c.criado_em || '';

                // Serviço, equipamento e DIO/porta descrevem a ORIGEM do sinal que chega
                // aqui — vêm do rastreio, não do cadastro da caixa.
                var pot = c.potencia || null;
                var org = pot ? (pot.origem || {}) : {};
                var entradaCto = '';
                (c.estimativas_entrada_cto || []).forEach(function (e) {
                    entradaCto += '<div class="ftth-estimativa ftth-estimativa--entrada">'
                        + '<span class="ftth-sub">Entrada da CTO · ' + esc(e.splitter_nome) + '</span>';
                    if (e.dbm !== null && e.dbm !== undefined) {
                        entradaCto += '<strong>' + dbm(e.dbm) + '</strong>'
                            + '<span class="ftth-sub">TX da PON: ' + dbm(e.tx_dbm)
                            + ' · perda acumulada até a entrada: '
                            + (e.perda_total_db === null || e.perda_total_db === undefined
                                ? '—' : Number(e.perda_total_db).toFixed(2) + ' dB') + '</span>';
                        entradaCto += '<span class="ftth-sub">OLT: ' + esc(e.olt || '—') + ' · PON: '
                        + esc(e.pon || '—') + '</span>';
                    entradaCto += '<span class="ftth-sub">Fonte: ' + esc(e.fonte || 'manual') + ' · '
                            + (e.fonte === 'OLTManager'
                                ? (e.coletado_em ? 'coletado em ' + esc(e.coletado_em) : 'horário da coleta não informado')
                                : 'valor manual cadastrado; sem horário de coleta')
                            + (e.desatualizado
                                ? ' · coleta atrasada (intervalo configurado de ' + Number(e.intervalo_coleta_horas).toFixed(1) + ' h)'
                                : '') + '</span>';
                    } else {
                        entradaCto += '<strong>Sem estimativa</strong>'
                            + '<span class="ftth-sub">' + esc(e.motivo || 'Verifique o vínculo da PON e o caminho óptico.') + '</span>';
                    }
                    entradaCto += '</div>';
                });

                var html =
                    '<div class="ftth-ficha-topo">'
                  +   '<h3 class="ftth-painel-titulo">'
                  +     marcaDoTipo(c.tipo, c.cor) + ' '
                  +     esc(c.nome) + '</h3>'
                  +   '<p class="ftth-sub">' + esc(c.tipo) + ' · ' + esc(c.regiao) + ' ' + selo + '</p>'
                  + '</div>'

                  + '<dl class="ftth-ficha">'
                  +   linha('Serviço', juntar([org.servico]))
                  +   linha('Equipamento', juntar([org.olt, org.pon]))
                  +   linha('DIO / Porta', juntar([org.dio, org.porta]))
                  +   linha('Cabos que chegam', alimentacao)
                  +   linha('Splitter local', splitterLocal)
                  +   linha('Origem', c.origem === 'kmz' ? 'importada do KMZ' : 'cadastro manual')
                  + '</dl>'

                  + '<p class="ftth-ficha-autor">Por ' + esc(quem)
                  +   (quando ? ' · ' + esc(quando) : '') + '</p>';

                if (portas) {
                    html += '<div class="ftth-barra"><span style="width:' + pct + '%"></span></div>'
                          + '<p class="ftth-sub">' + ocupadas + ' de ' + portas + ' portas ocupadas ('
                          + pct + '%)</p>';
                }

                // No POP o trabalho é outro: OLT, DIO e a grade de portas. A ligação da
                // porta com a fibra é feita lá, por seletor, e grava no mesmo grafo — por
                // isso a caixa DC não precisa de diagrama.
                html += (c.tipo === 'DC'
                     ?  '<a class="ftth-btn ftth-btn--pri ftth-ficha-principal" '
                        + 'href="pop.php?caixa=' + c.id + '"><i class="bi-hdd-rack-fill"></i> Data Center</a>'
                     :  '<a class="ftth-btn ftth-btn--pri ftth-ficha-principal" '
                        + 'href="caixa.php?id=' + c.id + '"><i class="bi-diagram-3-fill"></i> Diagrama</a>')
                     +  '<div class="ftth-ficha-acoes">'
                     // Só faz sentido onde há splitter de atendimento: é dele que sai o
                     // drop do cliente. Numa CEO de passagem o botão continua apagado.
                     +    '<button class="ftth-acao" id="fc-clientes" data-id="' + c.id + '"'
                     +      (portas ? '' : ' disabled title="Esta caixa não tem splitter de atendimento"')
                     +      '><i class="bi-people-fill"></i> Clientes'
                     +      (ocupadas ? ' <b>' + ocupadas + '</b>' : '') + '</button>'
                     +    '<button class="ftth-acao" id="fc-centralizar" data-lat="' + c.lat + '" data-lng="' + c.lng + '">'
                     +      '<i class="bi-geo-fill"></i> Ver no mapa</button>'
                     // Atalho para a rota completa: a estimativa logo abaixo responde
                     // "quanto chega aqui", o botão responde "por onde veio". Sem caminho
                     // óptico não há o que mostrar, então fica apagado.
                     +    '<button class="ftth-acao" id="fc-sinal" data-id="' + c.id + '"'
                     +      ' data-nome="' + esc(c.nome) + '"'
                     +      (pot ? '' : ' disabled title="Esta caixa não tem caminho óptico até uma OLT"')
                     +      '><i class="bi-reception-4"></i> Sinal</button>'
                     +    (c.tipo === 'CTO' || c.tipo === 'CTO_AP'
                            ? '<a class="ftth-acao" href="campo.php?caixa=' + c.id + '">'
                              + '<i class="bi-tools"></i> Ficha de campo</a>'
                            : '<button class="ftth-acao" disabled title="Disponível apenas para CTO">'
                              + '<i class="bi-camera-fill"></i> Ficha de campo</button>')
                     +    '<button class="ftth-acao" id="fc-editar" data-id="' + c.id + '">'
                     +      '<i class="bi-pencil-square"></i> Editar</button>'
                     +    '<button class="ftth-acao ftth-acao--perigo" '
                     +      'id="fc-excluir" data-id="' + c.id + '" data-versao="' + c.versao + '" '
                     +      'data-nome="' + esc(c.nome) + '">'
                     +      '<i class="bi-trash3-fill"></i> Excluir</button>'
                     +  '</div>'

                     +  '<div class="ftth-ficha-rastreio">'
                     +    '<p class="ftth-ficha-secao">Informações técnicas e rastreio</p>'
                     +    '<div class="ftth-estimativa' + (pot ? ' ftth-estimativa--' + esc(pot.classe) : '') + '">'
                     +      '<span class="ftth-sub">Estimativa de sinal</span>'
                     +      (pot
                            ? '<strong>' + dbm(pot.dbm)
                              + (pot.classe ? ' <small>' + esc(pot.classe) + '</small>' : '') + '</strong>'
                              + '<span class="ftth-sub">na ' + esc(pot.onde)
                              + ' · ' + pot.saltos + ' salto(s) desde ' + esc(org.caixa || '—') + '</span>'
                            : '<strong>sem caminho óptico</strong>'
                              + '<span class="ftth-sub">' + (c.ligacoes > 0
                                  ? 'há ligações aqui, mas nenhuma chega a uma porta de DIO com equipamento'
                                  : 'nenhuma fusão registrada nesta caixa') + '</span>')
                     +    '</div>'
                     +    entradaCto
                     +    '<p class="ftth-sub ftth-coord">Localização: <span class="mono" id="fc-coord">'
                     +      parseFloat(c.lat).toFixed(6) + ', ' + parseFloat(c.lng).toFixed(6) + '</span> '
                     +      '<button class="ftth-copiar" id="fc-copiar" title="Copiar">copiar</button></p>'
                     +  '</div>'
                     +  '';

                painel(html);
            },
            onErro: function (m) { painel('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>'); }
        });
    }

    /**
     * Ficha da Reserva: é cabo enrolado, não caixa. Sem diagrama, clientes nem sinal — só
     * os metros, o cabo em que ela está e quanto esse vão soma de reserva no total.
     */
    function fichaReserva(c) {
        var v = c.vao_reserva;
        var quem = c.alterado_por || c.criado_por || '—';
        var quando = c.alterado_em || c.criado_em || '';

        return '<div class="ftth-ficha-topo">'
          +   '<h3 class="ftth-painel-titulo">' + marcaDoTipo(c.tipo, c.cor) + ' ' + esc(c.nome) + '</h3>'
          +   '<p class="ftth-sub">Reserva técnica · ' + esc(c.regiao)
          +     (v ? '' : ' <span class="ftth-selo ftth-selo--pend">sem cabo</span>') + '</p>'
          + '</div>'
          + '<dl class="ftth-ficha">'
          +   linha('Metros de reserva', c.reserva_m ? metros(c.reserva_m) : '—')
          +   linha('Cabo', v ? esc((v.cabo || 'sem nome') + ' · ' + v.tipo) : '—')
          +   linha('Trecho', v ? esc(v.caixa_ini + ' → ' + v.caixa_fim) : '—')
          +   linha('Reserva no trecho', v ? metros(v.reserva_m) : '—')
          +   linha('Comprimento óptico', v ? metros(v.comprimento_optico) : '—')
          +   linha('Origem', c.origem === 'kmz' ? 'importada do KMZ' : 'cadastro manual')
          + '</dl>'
          + '<p class="ftth-ficha-autor">Por ' + esc(quem) + (quando ? ' · ' + esc(quando) : '') + '</p>'
          + (v ? '' : '<div class="ftth-aviso">Esta reserva não está em nenhum cabo e não soma metros. '
                    + 'Edite e informe os metros: ela passa a ser do cabo que está sob o ponto.</div>')
          + '<div class="ftth-ficha-acoes">'
          +   '<button class="ftth-acao" id="fc-centralizar" data-lat="' + c.lat + '" data-lng="' + c.lng + '">'
          +     '<i class="bi-geo-fill"></i> Ver no mapa</button>'
          +   '<button class="ftth-acao" id="fc-editar" data-id="' + c.id + '">'
          +     '<i class="bi-pencil-square"></i> Editar</button>'
          +   '<button class="ftth-acao ftth-acao--perigo" id="fc-excluir" data-id="' + c.id + '"'
          +     ' data-versao="' + c.versao + '" data-nome="' + esc(c.nome) + '">'
          +     '<i class="bi-trash3-fill"></i> Excluir</button>'
          + '</div>'
          + '<p class="ftth-sub ftth-coord">Localização: <span class="mono" id="fc-coord">'
          +   parseFloat(c.lat).toFixed(6) + ', ' + parseFloat(c.lng).toFixed(6) + '</span> '
          +   '<button class="ftth-copiar" id="fc-copiar" title="Copiar">copiar</button></p>';
    }

    /**
     * Poste: não tem splitter, fusão nem diagrama — o cabo passa por ele. A ficha só diz onde
     * ele está; as ações são as de qualquer ponto.
     */
    function fichaPoste(c) {
        var quem = c.alterado_por || c.criado_por || '—';
        var quando = c.alterado_em || c.criado_em || '';
        return '<div class="ftth-ficha-topo">'
          +   '<h3 class="ftth-painel-titulo">' + marcaDoTipo(c.tipo, c.cor) + ' ' + esc(c.nome) + '</h3>'
          +   '<p class="ftth-sub">Poste · ' + esc(c.regiao) + '</p>'
          + '</div>'
          + '<dl class="ftth-ficha">'
          +   linha('Origem', c.origem === 'kmz' ? 'importado do KMZ' : 'cadastro manual')
          +   (c.observacao ? linha('Observação', esc(c.observacao)) : '')
          + '</dl>'
          + '<p class="ftth-ficha-autor">Por ' + esc(quem) + (quando ? ' · ' + esc(quando) : '') + '</p>'
          + '<div class="ftth-ficha-acoes">'
          +   '<button class="ftth-acao" id="fc-centralizar" data-lat="' + c.lat + '" data-lng="' + c.lng + '">'
          +     '<i class="bi-geo-fill"></i> Ver no mapa</button>'
          +   '<button class="ftth-acao" id="fc-editar" data-id="' + c.id + '">'
          +     '<i class="bi-pencil-square"></i> Editar</button>'
          +   '<button class="ftth-acao ftth-acao--perigo" id="fc-excluir" data-id="' + c.id + '"'
          +     ' data-versao="' + c.versao + '" data-nome="' + esc(c.nome) + '">'
          +     '<i class="bi-trash3-fill"></i> Excluir</button>'
          + '</div>'
          + '<p class="ftth-sub ftth-coord">Localização: <span class="mono" id="fc-coord">'
          +   parseFloat(c.lat).toFixed(6) + ', ' + parseFloat(c.lng).toFixed(6) + '</span> '
          +   '<button class="ftth-copiar" id="fc-copiar" title="Copiar">copiar</button></p>';
    }

    /**
     * Ponta livre: não tem splitter, fusão nem diagrama. A ficha só diz de que cabo ela é e
     * oferece os dois caminhos — virar um ponto de verdade, ou continuar o cabo dali.
     */
    function fichaPonta(c) {
        var v = (c.cabos || [])[0] || null;
        var ate = v ? (/^PONTA\./.test(v.sentido) ? 'outra ponta livre' : v.sentido) : '';
        return '<div class="ftth-ficha-topo">'
          +   '<h3 class="ftth-painel-titulo"><i class="bi-record-circle"></i> Ponta livre</h3>'
          +   '<p class="ftth-sub">Ponta de cabo sem caixa · ' + esc(c.regiao) + '</p>'
          + '</div>'
          + '<dl class="ftth-ficha">'
          +   linha('Cabo', v ? esc((v.cabo || 'sem nome') + ' · ' + v.tipo) : '—')
          +   linha('Vai até', v ? esc(ate) : '—')
          + '</dl>'
          + '<div class="ftth-aviso">Para ancorar, transforme a ponta num ponto (CTO, CEO…) ou solte um '
          +   'ponto em cima dela. Para seguir com o cabo, use Continuar cabo.</div>'
          + '<div class="ftth-ficha-acoes">'
          +   '<button class="ftth-acao" id="fc-centralizar" data-lat="' + c.lat + '" data-lng="' + c.lng + '">'
          +     '<i class="bi-geo-fill"></i> Ver no mapa</button>'
          +   '<button class="ftth-acao" id="fp-virar" data-id="' + c.id + '">'
          +     '<i class="bi-geo-alt-fill"></i> Virar ponto</button>'
          +   '<button class="ftth-acao" id="fp-continuar" data-id="' + c.id + '" data-lat="' + c.lat
          +     '" data-lng="' + c.lng + '" data-nome="' + esc(v ? (v.cabo || 'cabo sem nome') : 'cabo')
          +     '" data-tipo="' + esc(v ? v.tipo : '') + '" data-cor="' + esc(v ? v.cor_rota : '') + '"'
          +     (v ? '' : ' disabled') + '>'
          +     '<i class="bi-share-fill"></i> Continuar cabo</button>'
          + '</div>'
          + '<p class="ftth-sub ftth-coord">Localização: <span class="mono" id="fc-coord">'
          +   parseFloat(c.lat).toFixed(6) + ', ' + parseFloat(c.lng).toFixed(6) + '</span> '
          +   '<button class="ftth-copiar" id="fc-copiar" title="Copiar">copiar</button></p>';
    }

    /**
     * A marca do tipo, para títulos em HTML: a silhueta quando o tipo tem uma, senão o
     * ícone do painel. Mesma fonte do marcador do mapa — o desenho vive no PHP.
     */
    function marcaDoTipo(tipo, cor) {
        var silhuetas = (window.FTTH_MAPA || {}).silhuetas || {};
        if (silhuetas[tipo]) {
            return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20"'
                 + ' height="20" class="ftth-silhueta">'
                 + silhuetas[tipo].split('{cor}').join(cor || '#4A5568') + '</svg>';
        }
        return '<i class="' + (ICONE_CLASSE[tipo] || 'bi-box-seam') + '"></i>';
    }

    /** −19,25 dBm — sinal explícito e vírgula decimal, como no painel do diagrama. */
    function dbm(v) {
        var n = parseFloat(v);
        if (isNaN(n)) return '—';
        return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2).replace('.', ',') + ' dBm';
    }

    function linha(rotulo, valor) {
        return '<dt>' + esc(rotulo) + '</dt><dd>' + valor + '</dd>';
    }

    /** Partes vazias somem; sobrando nada, o traço — `linha()` recebe HTML já escapado. */
    function juntar(partes) {
        var v = partes.filter(function (x) { return x; }).join(' · ');
        return v ? esc(v) : '—';
    }

    /**
     * Excluir caixa — com um desvio quando ela é só uma emenda no meio de um cabo.
     *
     * Nesse caso, apagar a caixa sem mais nada deixaria o cabo partido em dois lances que não
     * se encontram. Então o servidor é consultado antes: se a caixa só faz as fibras passarem
     * entre dois trechos do mesmo cabo, a exclusão junta os trechos de volta num lance só — e
     * isso é dito ao operador antes, porque excluir caixa e reescrever cabo são duas coisas.
     */
    function excluirCaixa(id, versao, nome) {
        var cfg = window.FTTH_MAPA || {};

        FTTH.chamar({
            url: 'mapa.php?ajax=emenda_simples&caixa=' + id,
            onOk: function (d) {
                var e = d && d.emenda;
                if (e) {
                    var metros = Number(e.metros).toFixed(1).replace('.', ',');
                    var msg = 'A caixa "' + nome + '" só emenda os dois trechos do cabo '
                            + (e.cabo_nome ? '"' + e.cabo_nome + '"' : e.nome_ini + ' → ' + e.nome_fim)
                            + '.\n\nExcluir vai juntar os trechos num lance único de ' + metros + ' m'
                            + (e.ligacoes ? ', desfazendo as ' + e.ligacoes + ' passagens desta caixa' : '')
                            + '.\n\nConfirma?';
                    if (!confirm(msg)) return;
                    unirEExcluir(id, versao, nome, e);
                    return;
                }
                if (!confirm('Excluir "' + nome + '"?\n\nSai do mapa, mas continua no histórico.')) {
                    return;
                }
                excluirCaixaMesmo(id, versao);
            },
            // Se a consulta falhar, segue o caminho normal: o servidor recusa se não puder.
            onErro: function () {
                if (!confirm('Excluir "' + nome + '"?\n\nSai do mapa, mas continua no histórico.')) {
                    return;
                }
                excluirCaixaMesmo(id, versao);
            }
        });
    }

    function excluirCaixaMesmo(id, versao, manterCabos) {
        var cfg = window.FTTH_MAPA || {};
        FTTH.chamar({
            url: 'mapa.php?ajax=excluir_caixa',
            method: 'POST',
            data: { csrf: cfg.csrf, id: id, versao: versao, manter_cabos: manterCabos ? 1 : 0 },
            onOk: function (d) {
                $('#painel').hide();
                carregar();
                FTTH.toast('ok', d && d.ponta
                    ? 'Caixa excluída. ' + plural(d.cabos, 'cabo ficou', 'cabos ficaram')
                      + ' no mapa, com ponta livre no lugar dela.'
                    : 'Caixa excluída.');
            },
            // O recado vai para o toast, e não para dentro da ficha: a ficha fecha, o toast
            // fica onde o operador está olhando.
            onErro: function (m, resp) {
                // Caixa com cabo (0.9.6): em vez de mandar apagar os cabos antes, oferece
                // manter os cabos no mapa com uma ponta livre no lugar da caixa.
                var e = resp && resp.errors && resp.errors[0];
                if (!manterCabos && e && e.code === 'FTTH-TOP-016' && e.details && e.details.vaos > 0) {
                    if (confirm(m + '\n\nExcluir mesmo assim, mantendo os cabos no mapa?\n'
                            + 'Eles ficam com uma ponta livre aqui, e as fusões desta caixa são desfeitas.')) {
                        excluirCaixaMesmo(id, versao, true);
                    }
                    return;
                }
                FTTH.toast('erro', m);
            }
        });
    }

    function unirEExcluir(id, versao, nome, emenda) {
        var cfg = window.FTTH_MAPA || {};
        FTTH.chamar({
            url: 'mapa.php?ajax=unir_vaos',
            method: 'POST',
            data: { csrf: cfg.csrf, caixa: id, versao: versao },
            onOk: function (d) {
                $('#painel').hide();
                carregar();
                FTTH.toast('ok', nome + ' excluída e o cabo voltou a ser um lance só: '
                    + Number(d.metros).toFixed(1).replace('.', ',') + ' m entre '
                    + d.nome_ini + ' e ' + d.nome_fim + '.');
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        });
    }

    /**
     * Ficha do cabo — mesmo desenho da ficha de caixa: topo, ações e rastreio.
     * O vão clicado é o que dá os números de campo (comprimento, pontas, vértices);
     * nome, fabricante e capacidade são do CABO, e é sobre ele que as ações agem.
     */
    function abrirCabo(v) {
        var cfg = window.FTTH_MAPA || {};
        caboAberto = v;

        var origem = v.cabo_origem === 'kmz' ? 'importado do KMZ' : 'cadastro manual';
        var selo = v.status && v.status !== 'implantado'
                 ? ' <span class="ftth-selo ftth-selo--novo">' + esc(v.status) + '</span>' : '';

        var html =
            '<div class="ftth-ficha-topo">'
          +   '<h3 class="ftth-painel-titulo"><i class="bi-share-fill"></i> '
          +     esc(v.cabo_nome || ('Cabo ' + v.cabo_tipo)) + '</h3>'
          +   '<p class="ftth-sub">Fibra óptica · ' + esc(v.caixa_ini) + ' → '
          +     esc(v.caixa_fim) + selo + '</p>'
          + '</div>'

          + '<button class="ftth-btn ftth-btn--pri ftth-ficha-principal" id="fb-editar">'
          +   '<i class="bi-pencil-square"></i> Editar cabo</button>'

          + '<div class="ftth-ficha-acoes ftth-ficha-acoes--duo">'
          +   '<button class="ftth-acao" id="fb-centralizar">'
          +     '<i class="bi-geo-fill"></i> Ver no mapa</button>'
          +   '<button class="ftth-acao ftth-acao--perigo" id="fb-excluir">'
          +     '<i class="bi-trash3-fill"></i> Excluir cabo</button>'
          + '</div>'

          + '<div class="ftth-ficha-rastreio">'
          +   '<p class="ftth-ficha-secao">Informações técnicas e rastreio</p>'
          +   '<dl class="ftth-ficha">'
          +     linha('Nome do cabo', esc(v.cabo_nome || '—'))
          +     linha('Fabricante', esc(v.fabricante || '—'))
          +     linha('Capacidade total', esc(v.cabo_tipo))
          +     linha('Construção do tubo', esc(v.construcao || '—'))
          +     linha('Padrão de cores', esc(v.padrao_cores))
          +     linha('Comprimento do vão', metros(v.comprimento_geo))
          +     linha('Reserva técnica', parseFloat(v.reserva_m) > 0
                      ? metros(v.reserva_m) + ' (' + v.reservas + ' reserva' + (v.reservas == 1 ? '' : 's') + ')'
                      : '—')
          +     linha('Comprimento óptico', metros(v.comprimento_optico))
          +     linha('Caixa de início', esc(v.caixa_ini))
          +     linha('Caixa final', esc(v.caixa_fim))
          +     linha('Vértices na rota', (v.vertices || []).length)
          +     linha('Origem', origem)
          +   '</dl>'
          + '</div>'
          + '<div id="fb-saida"></div>';

        painel(html);
    }

    /** 160.43 -> "160,4 m" — o mapa fala em metros, não em decimais de engenharia. */
    function metros(valor) {
        var n = parseFloat(valor);
        return isNaN(n) ? '—' : n.toFixed(1).replace('.', ',') + ' m';
    }

    /** Enquadra o vão inteiro na tela — um cabo não cabe num ponto só. */
    function enquadrarVao(v) {
        if (!v || !(v.vertices || []).length) return;
        var area = new google.maps.LatLngBounds();
        v.vertices.forEach(function (p) {
            area.extend({ lat: parseFloat(p[0]), lng: parseFloat(p[1]) });
        });
        mapa.fitBounds(area);
    }

    /** Abre o modal de edição já preenchido com o que o cabo tem hoje. */
    function editarCabo(v) {
        $('#ec-titulo').text('Editar ' + (v.cabo_nome || ('cabo ' + v.cabo_tipo)));
        $('#ec-rota').text(v.caixa_ini + ' → ' + v.caixa_fim + ' · ' + metros(v.comprimento_geo));
        $('#ec-nome').val(v.cabo_nome || '');
        $('#ec-fabricante').val(v.fabricante || '');
        $('#ec-tipo').val(v.cabo_tipo_id);
        $('#ec-padrao').val(v.padrao_cores);
        $('#ec-espessura').val(v.espessura_mapa === null || v.espessura_mapa === undefined
            ? '' : String(v.espessura_mapa));
        $('#ec-status').val(v.status || 'implantado');
        $('#ec-cores .ftth-cor').removeClass('ativo').filter(function () {
            return $(this).data('cor') === (v.cor_rota || '#00E676');
        }).addClass('ativo');
        $('#ec-saida').empty();
        $('#modal-editar-cabo').show();
    }

    function salvarEdicaoCabo() {
        var cfg = window.FTTH_MAPA || {};
        var v = caboAberto;
        if (!v) return;

        var cor = $('#ec-cores .ftth-cor.ativo').data('cor') || v.cor_rota;
        var $b = $('#ec-salvar').prop('disabled', true);

        FTTH.chamar({
            url: 'mapa.php?ajax=alterar_cabo',
            method: 'POST',
            data: {
                csrf: cfg.csrf, cabo: v.cabo_id, versao: v.cabo_versao,
                nome: $('#ec-nome').val(), fabricante: $('#ec-fabricante').val(),
                cabo_tipo_id: $('#ec-tipo').val(), padrao_cores: $('#ec-padrao').val(),
                cor_rota: cor, espessura_mapa: $('#ec-espessura').val(),
                status: $('#ec-status').val()
            },
            onOk: function (d, resp) {
                $('#modal-editar-cabo').hide();
                // O cabo pode ter mudado de cor, largura ou capacidade: recarrega para o mapa
                // e a ficha contarem a mesma história.
                carregar();
                $('#painel').hide();
                var avisos = (resp && resp.warnings) || [];
                if (avisos.length) {
                    FTTH.toast('avis', 'Cabo salvo, com ressalva.',
                        avisos.map(function (w) { return w.message; }));
                } else {
                    FTTH.toast('ok', 'Cabo salvo.');
                }
            },
            onErro: function (m) {
                $('#ec-saida').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
            }
        }).always(function () { $b.prop('disabled', false); });
    }

    /**
     * Excluir cabo: o modal (mesmo desenho do "Excluir seleção") mostra antes o que sai junto —
     * trechos, reservas e as fusões por caixa. Com fibra ligada, confirmar desfaz as ligações e
     * exclui numa transação só (30/09/2026). Sem digitar nada: o modal já é a confirmação.
     */
    var caboExcluindo = null;

    function excluirCabo(v) {
        FTTH.chamar({
            url: 'mapa.php?ajax=cabo_previa&cabo=' + v.cabo_id,
            onOk: function (p) {
                caboExcluindo = { v: v, previa: p };
                var nome = v.cabo_nome || ('Cabo ' + v.cabo_tipo);
                var li = function (rotulo, valor, alerta) {
                    return '<li' + (alerta ? ' class="alerta"' : '') + '><span>' + rotulo + '</span><b>'
                         + valor + '</b></li>';
                };
                var html = '<p class="ftth-sub" style="margin:0 0 8px">Sai do mapa e continua no histórico.</p>'
                    + '<ul class="ftth-lote-lista">'
                    + li('Cabo', esc(nome + ' · ' + v.cabo_tipo))
                    + li('Trechos de cabo', p.vaos)
                    + (p.reservas ? li('Reservas nos trechos', p.reservas) : '')
                    + (p.ligacoes ? li('Fusões desfeitas', p.ligacoes, true) : '')
                    + '</ul>';
                if (p.caixas.length) {
                    html += '<div class="ftth-lote-detalhe">Fusões com fibra deste cabo, que saem junto '
                          + '(o sinal para de chegar depois delas):<ul>'
                          + p.caixas.map(function (c) {
                              return '<li>' + esc(c.nome) + ' — ' + plural(parseInt(c.fibras, 10), 'fusão', 'fusões') + '</li>';
                          }).join('') + '</ul></div>';
                }
                $('#xc-previa').html(html);
                $('#xc-saida').empty();
                $('#xc-excluir').prop('disabled', false);
                $('#modal-excluir-cabo').show();
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        });
    }

    function confirmarExclusaoCabo() {
        if (!caboExcluindo) return;
        var cfg = window.FTTH_MAPA || {};
        var v = caboExcluindo.v;
        var nome = v.cabo_nome || ('Cabo ' + v.cabo_tipo);
        var $b = $('#xc-excluir').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=excluir_cabo',
            method: 'POST',
            data: { csrf: cfg.csrf, cabo: v.cabo_id,
                    confirmacao: caboExcluindo.previa.ligacoes ? 'EXCLUIR' : '' },
            onOk: function (d) {
                $('#modal-excluir-cabo').hide();
                $('#painel').hide();
                caboAberto = null;
                caboExcluindo = null;
                carregar();
                FTTH.toast('ok', nome + ' excluído'
                    + (d && d.ligacoes_desfeitas ? ', com ' + plural(d.ligacoes_desfeitas, 'fusão desfeita',
                                                                    'fusões desfeitas') : '') + '.');
            },
            onErro: function (m) {
                $('#xc-saida').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
                $b.prop('disabled', false);
            }
        });
    }

    /** Extrai "CTO.18.10 — 2 fibra(s)" dos detalhes de um FTTH-TOP-016. */
    function caixasDoErro(resp) {
        var det = resp && resp.errors && resp.errors[0] && resp.errors[0].details;
        if (!det || !det.caixas) return null;
        return det.caixas.map(function (c) {
            return c.nome + ' — ' + c.fibras + ' fibra' + (c.fibras > 1 ? 's' : '');
        });
    }


    /* ------------------------------------------------------------------ clientes na porta */

    var caixaClientes = null;   // caixa cuja grade está aberta
    var clienteMapaAtual = null;

    /**
     * A grade de atendimento da caixa: uma linha por saída do splitter, com o cliente que
     * está ali ou um campo de busca.
     *
     * É o ponto onde a documentação encontra o cadastro do MK-AUTH: a porta aponta para um
     * `sis_cliente.id`, nunca para o login — login é atributo de exibição (F1).
     */
    function abrirClientes(caixaId) {
        caixaClientes = caixaId;
        $('#cl-corpo').html('<p class="ftth-sub">Carregando…</p>');
        $('#cl-resumo').empty();
        $('#modal-clientes').show();

        FTTH.chamar({
            url: 'mapa.php?ajax=atendimento&caixa=' + caixaId,
            onOk: function (d) {
                $('#cl-titulo').text('Clientes · ' + d.caixa.nome);
                $('#cl-corpo').html(htmlGradeClientes(d));

                var total = 0, ocupadas = 0;
                (d.splitters || []).forEach(function (s) {
                    total += s.saidas; ocupadas += s.ocupadas;
                });
                $('#cl-resumo').text(ocupadas + ' de ' + total + ' portas ocupadas');
            },
            onErro: function (m) {
                $('#cl-corpo').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
            }
        });
    }

    function htmlGradeClientes(d) {
        if (!d.splitters || !d.splitters.length) {
            return '<div class="ftth-aviso">Esta caixa não tem splitter de atendimento. '
                 + 'Adicione um pelo diagrama para poder vincular clientes.</div>';
        }
        var html = '';

        d.splitters.forEach(function (s) {
            html += '<div class="ftth-grupo-portas">'
                 +    '<div class="ftth-grupo-portas-topo">'
                 +      '<strong>' + esc(s.nome) + ' · ' + esc(s.razao) + '</strong>'
                 +      '<span>' + s.ocupadas + '/' + s.saidas + ' ocupadas</span>'
                 +    '</div>';

            s.portas.forEach(function (p) {
                var sinal = p.dbm === null || p.dbm === undefined
                    ? '<span class="ftth-porta-sinal ftth-porta-sinal--sem">sem sinal</span>'
                    : '<span class="ftth-porta-sinal">' + dbm(p.dbm) + '</span>';

                html += '<div class="ftth-porta-linha' + (p.cliente ? ' ocupada' : '')
                     +    (p.cliente && !p.cliente.ativo ? ' ftth-porta-linha--cancelada' : '') + '"'
                     +    ' data-splitter="' + s.id + '" data-numero="' + p.numero + '">'
                     +    '<span class="ftth-porta-rotulo">' + esc(p.rotulo) + '</span>'
                     +    sinal;

                if (p.cliente) {
                    // Cliente cancelado ocupando porta é capacidade parada: a linha diz
                    // isso em vez de parecer um atendimento como os outros.
                    html += '<span class="ftth-porta-cliente'
                         +    (p.cliente.ativo ? '' : ' ftth-porta-cliente--cancelado') + '">'
                         +    esc(p.cliente.login)
                         +    (p.cliente.identificacao ? '<small class="ftth-porta-ponto">'
                              + ' · ' + esc(p.cliente.identificacao) + '</small>' : '')
                         +    (p.cliente.ativo ? ''
                              : ' <span class="ftth-selo ftth-selo--erro">cancelado</span>')
                         +  '</span>'
                         +  '<button class="ftth-btn ftth-btn--sec ftth-porta-acao '
                         +    (p.cliente.instalacao_id ? 'js-desvincular-instalacao' : 'js-desvincular') + '"'
                         +    ' data-cliente="' + p.cliente.cliente_id + '"'
                         +    (p.cliente.instalacao_id ? ' data-instalacao="' + p.cliente.instalacao_id + '"' : '')
                         +    ' data-login="' + esc(p.cliente.login) + '">Tirar</button>';
                } else if (p.reserva) {
                    html += '<span class="ftth-porta-cliente"><span class="ftth-selo ftth-selo--info">reservada</span> '
                         + esc(p.reserva.referencia || ('por ' + p.reserva.reservado_por))
                         + '<small class="ftth-porta-ponto"> até ' + esc(p.reserva.expira_em) + '</small></span>';
                } else {
                    html += '<div class="ftth-porta-busca">'
                         +    '<input class="ftth-campo js-busca-cliente" placeholder="buscar cliente…"'
                         +      ' autocomplete="off">'
                         +    '<div class="ftth-porta-lista"></div>'
                         +  '</div>';
                }
                html += '</div>';
            });
            html += '</div>';
        });
        return html;
    }

    /** Resultados da busca, já dizendo quem não está livre. */
    function htmlResultadosCliente(lista) {
        if (!lista.length) {
            return '<div class="ftth-porta-item ftth-porta-item--vazio">nenhum cliente encontrado</div>';
        }
        return lista.map(function (c) {
            // Sem selo de situação: a busca já só devolve cliente ativo.
            return '<div class="ftth-porta-item js-escolher-cliente" data-id="' + c.id + '"'
                 +    ' data-login="' + esc(c.login) + '"'
                 +    ' data-ja="' + esc(c.ja_em || '') + '">'
                 +    '<strong>' + esc(c.login) + '</strong>'
                 +    '<span>' + esc(c.nome || '') + '</span>'
                 +    (c.ja_em ? '<span class="ftth-porta-item-ja">já em ' + esc(c.ja_em) + '</span>'
                               : (c.endereco ? '<span>' + esc(c.endereco) + '</span>' : ''))
                 +  '</div>';
        }).join('');
    }

    function abrirClienteMapa(clienteId, instalacaoId, contexto) {
        clienteMapaAtual = Number(clienteId);
        $('#cliente-mapa-titulo').text('Cliente e instalações');
        $('#cliente-mapa-corpo').html('<p class="ftth-sub">Carregando cadastro…</p>');
        $('#modal-cliente-mapa').show();
        FTTH.chamar({
            url: 'mapa.php?ajax=instalacao_dados&cliente=' + clienteMapaAtual,
            onOk: function (d) {
                $('#cliente-mapa-titulo').text((d.cliente.login || 'Cliente') + ' · instalações');
                var contextoHtml = '';
                if (contexto) {
                    var tipo = contexto.bloqueado
                        ? (contexto.tipo === 'adicional' ? 'Conta adicional bloqueada' : 'Cliente bloqueado')
                        : contexto.tipo === 'adicional' ? 'Conta adicional'
                        : contexto.tipo === 'instalacao' ? 'Ponto de instalação adicional' : 'Cliente normal';
                    contextoHtml = '<div class="ftth-mapa-contexto ' + (contexto.bloqueado ? 'bloqueado' : '') + '">'
                        + '<strong>' + esc(tipo) + '</strong>'
                        + (contexto.login ? '<span>' + esc(contexto.login) + '</span>' : '')
                        + '</div>';
                }
                $('#cliente-mapa-corpo').html(contextoHtml + htmlClienteMapa(d));
                if (instalacaoId) {
                    setTimeout(function () {
                        var el = document.getElementById('instalacao-' + Number(instalacaoId));
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 50);
                }
            },
            onErro: function (m) {
                $('#cliente-mapa-corpo').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
            }
        });
    }

    function resumoPorta(p) {
        if (!p) return '<span class="ftth-selo">Sem vínculo com CTO</span>';
        return '<span class="ftth-selo ftth-selo--ok">' + esc(p.caixa_nome) + ' · '
            + esc(p.splitter_nome) + ' · saída ' + Number(p.numero) + '</span>';
    }

    function htmlFormVinculo(installationId) {
        return '<div class="ftth-inst-vinculo js-form-vinculo" data-inst="' + Number(installationId || 0)
            + '" style="display:none">'
            + '<label class="ftth-rotulo-campo">Buscar CTO pelo nome</label>'
            + '<input class="ftth-campo js-cto-busca" autocomplete="off" placeholder="Digite o nome da CTO…">'
            + '<div class="ftth-cto-resultados js-cto-resultados"></div>'
            + '<div class="ftth-inst-selecao">'
            + '<select class="ftth-campo js-inst-splitter"><option value="">Escolha uma CTO primeiro</option></select>'
            + '<select class="ftth-campo js-inst-porta"><option value="">Escolha o splitter</option></select>'
            + '</div>'
            + '<button type="button" class="ftth-btn ftth-btn--pri js-inst-vincular">Vincular à porta</button>'
            + '</div>';
    }

    function htmlClienteMapa(d) {
        var c = d.cliente || {}, ponto = c.coordenada, ativo = c.principal_ativa === true;
        var html = '<div class="ftth-cliente-resumo"><strong>' + esc(c.nome || c.login) + '</strong>'
            + '<span>Login: ' + esc(c.login) + '</span>'
            + (c.endereco_exibicao ? '<span>' + esc(c.endereco_exibicao) + '</span>' : '')
            + (!ativo ? '<span class="ftth-selo">Cadastro inativo · edição e novos vínculos bloqueados</span>' : '')
            + '</div><section class="ftth-inst-card" id="instalacao-principal">'
            + '<div class="ftth-inst-card-topo"><strong>Instalação principal · cadastro MK-AUTH</strong>'
            + resumoPorta(c.principal) + '</div>'
            + '<p class="ftth-sub">' + (ponto ? 'Localização do cadastro: ' + Number(ponto.lat).toFixed(6)
                + ', ' + Number(ponto.lng).toFixed(6) : 'Este cadastro não tem coordenada reconhecida.') + '</p>'
            + '<div class="ftth-inst-acoes">'
            + (ativo ? '<button type="button" class="ftth-btn ftth-btn--sec js-inst-vinculo-abrir" data-inst="0">'
                + (c.principal ? 'Vincular / alterar CTO' : 'Vincular a uma CTO') + '</button>' : '')
            + (c.principal ? '<button type="button" class="ftth-btn ftth-btn--sec js-cliente-desvincular">Desvincular</button>' : '')
            + '</div>' + (ativo ? htmlFormVinculo(0) : '') + '</section>';

        html += '<div class="ftth-inst-lista-titulo">Outras instalações</div>';
        if (!d.instalacoes || !d.instalacoes.length) {
            html += '<p class="ftth-sub">Nenhum ponto adicional cadastrado.</p>';
        }
        (d.instalacoes || []).forEach(function (i) {
            var ocupada = i.vinculo_id !== null && i.vinculo_id !== undefined;
            html += '<section class="ftth-inst-card" id="instalacao-' + Number(i.id) + '">'
                + '<div class="ftth-inst-card-topo"><strong>' + esc(i.identificacao) + '</strong>'
                + (ocupada ? '<span class="ftth-selo ftth-selo--ok">' + esc(i.caixa_nome) + ' · '
                    + esc(i.splitter_nome) + ' · saída ' + Number(i.numero) + '</span>'
                    : '<span class="ftth-selo">Sem vínculo com CTO</span>') + '</div>'
                + '<div class="ftth-inst-form' + (ativo ? ' js-inst-editar' : '') + '" data-id="' + Number(i.id) + '">'
                + (ativo
                    ? '<label class="ftth-rotulo-campo">Identificação</label><input class="ftth-campo js-inst-identificacao" maxlength="80" value="'
                        + esc(i.identificacao) + '">'
                        + '<label class="ftth-rotulo-campo">Endereço</label><input class="ftth-campo js-inst-endereco" maxlength="180" value="'
                        + esc(i.endereco || '') + '">'
                        + '<div class="ftth-inst-coordenadas"><label>Latitude<input class="ftth-campo js-inst-lat" type="number" step="any" value="'
                        + Number(i.lat).toFixed(7) + '"></label><label>Longitude<input class="ftth-campo js-inst-lng" type="number" step="any" value="'
                        + Number(i.lng).toFixed(7) + '"></label></div>'
                        + '<label class="ftth-rotulo-campo">Observação</label><input class="ftth-campo js-inst-observacao" maxlength="500" value="'
                        + esc(i.observacao || '') + '">'
                    : '<p class="ftth-sub">' + esc(i.endereco || 'Endereço não informado') + '<br>'
                        + Number(i.lat).toFixed(6) + ', ' + Number(i.lng).toFixed(6)
                        + (i.observacao ? '<br>' + esc(i.observacao) : '') + '</p>')
                + '<div class="ftth-inst-acoes">'
                + (ativo ? '<button type="button" class="ftth-btn ftth-btn--sec js-inst-salvar">Salvar ponto</button>' : '')
                + (ocupada ? '<button type="button" class="ftth-btn ftth-btn--sec js-inst-desvincular" data-id="' + Number(i.id) + '">Desvincular CTO</button>'
                    : (ativo ? '<button type="button" class="ftth-btn ftth-btn--sec js-inst-vinculo-abrir" data-inst="' + Number(i.id) + '">Vincular a uma CTO</button>' : ''))
                + (!ocupada ? '<button type="button" class="ftth-btn ftth-btn--perigo js-inst-excluir" data-id="' + Number(i.id) + '">Excluir</button>' : '')
                + '</div>' + (ativo && !ocupada ? htmlFormVinculo(Number(i.id)) : '') + '</div></section>';
        });

        if (!ativo) {
            return html + '<p class="ftth-sub">Para alterar pontos ou criar novos vínculos, o cadastro precisa estar ativo. Vínculos existentes ainda podem ser removidos.</p>';
        }

        var centro = mapa && mapa.getCenter() ? mapa.getCenter() : null;
        var lat = centro ? centro.lat() : '';
        var lng = centro ? centro.lng() : '';
        html += '<section class="ftth-inst-card ftth-inst-nova"><strong>Adicionar outro ponto</strong>'
            + '<p class="ftth-sub">A localização fica somente no addon FTTH. Você pode ajustar o mapa e usar o centro como ponto.</p>'
            + '<label class="ftth-rotulo-campo">Identificação do ponto</label><input id="im-identificacao" class="ftth-campo" maxlength="80" placeholder="Ex.: Sicredi · link dedicado">'
            + '<label class="ftth-rotulo-campo">Endereço</label><input id="im-endereco" class="ftth-campo" maxlength="180">'
            + '<div class="ftth-inst-coordenadas"><label>Latitude<input id="im-lat" class="ftth-campo" type="number" step="any" value="'
            + (lat === '' ? '' : Number(lat).toFixed(7)) + '"></label><label>Longitude<input id="im-lng" class="ftth-campo" type="number" step="any" value="'
            + (lng === '' ? '' : Number(lng).toFixed(7)) + '"></label></div>'
            + '<label class="ftth-rotulo-campo">Observação</label><input id="im-observacao" class="ftth-campo" maxlength="500">'
            + '<div class="ftth-inst-acoes"><button type="button" class="ftth-btn ftth-btn--sec" id="im-usar-centro">Usar centro do mapa</button>'
            + '<button type="button" class="ftth-btn ftth-btn--pri" id="im-criar">Salvar instalação</button></div></section>';
        return html;
    }

    function carregarClientesSemLocalizacao(reset) {
        if (reset) semLocalizacaoOffset = 0;
        var q = $.trim($('#clientes-sem-localizacao-busca').val() || '');
        if (reset) $('#lista-clientes-sem-localizacao').html('<p class="ftth-sub">Carregando…</p>');
        FTTH.chamar({
            url: 'mapa.php?ajax=clientes_sem_localizacao&q=' + encodeURIComponent(q)
                + '&offset=' + semLocalizacaoOffset,
            onOk: function (d) {
                $('#clientes-sem-localizacao-conta').text(d.total || 0);
                if (!semLocalizacaoOffset) $('#lista-clientes-sem-localizacao').empty();
                if (!(d.clientes || []).length && !semLocalizacaoOffset) {
                    $('#lista-clientes-sem-localizacao').html('<p class="ftth-gaveta-vazio">Todos os clientes ativos têm uma localização ou ponto adicional.</p>');
                }
                (d.clientes || []).forEach(function (c) {
                    $('#lista-clientes-sem-localizacao').append(
                        '<button type="button" class="ftth-cliente-sem-local js-cliente-sem-local" data-id="' + Number(c.id) + '">'
                        + '<strong>' + esc(c.login) + '</strong><span>' + esc(c.nome || '') + '</span>'
                        + (c.endereco ? '<small>' + esc(c.endereco) + '</small>' : '') + '</button>');
                });
                semLocalizacaoOffset += (d.clientes || []).length;
                $('#clientes-sem-localizacao-mais').toggle(!!d.mais);
            },
            onErro: function (m) {
                if (reset) $('#lista-clientes-sem-localizacao').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
            }
        });
    }

    var semLocalizacaoOffset = 0;

    function vincularCliente(splitterId, numero, clienteId, mover) {
        var cfg = window.FTTH_MAPA || {};
        FTTH.chamar({
            url: 'mapa.php?ajax=vincular_cliente',
            method: 'POST',
            data: { csrf: cfg.csrf, cliente: clienteId, splitter: splitterId,
                    numero: numero, mover: mover ? '1' : '0' },
            onOk: function (d, resp) {
                abrirClientes(caixaClientes);   // redesenha a grade inteira
                atualizarFichaAberta();         // a ficha fica à vista, ao lado do modal
                carregar();                      // a ocupação da caixa muda no mapa
                mostrarAvisos(resp, d.login + ' vinculado na saída ' + numero + '.');
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        });
    }

    function desvincularCliente(clienteId, login) {
        var cfg = window.FTTH_MAPA || {};
        if (!confirm('Tirar ' + login + ' desta porta?')) return;

        FTTH.chamar({
            url: 'mapa.php?ajax=desvincular_cliente',
            method: 'POST',
            data: { csrf: cfg.csrf, cliente: clienteId },
            onOk: function (d, resp) {
                abrirClientes(caixaClientes);
                atualizarFichaAberta();
                carregar();
                mostrarAvisos(resp, login + ' saiu da porta.');
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        });
    }

    /**
     * Redesenha a ficha da caixa que está aberta atrás do modal.
     *
     * Ela mostra a contagem de portas ocupadas e a barra de ocupação, e ficaria mentindo
     * enquanto o modal some e volta — o usuário veria "1 de 8" ao lado de "2 de 8".
     */
    function atualizarFichaAberta() {
        if (caixaClientes && $('#painel').is(':visible')) {
            abrirFicha(caixaClientes);
        }
    }

    /**
     * O vínculo escreve em `sis_cliente` e na nativa `cto` quando a sincronização está
     * ligada, e isso produz avisos que ninguém mais mostraria — eles dizem, por exemplo,
     * que o nome da caixa não coube no campo da nativa.
     */
    function mostrarAvisos(resp, textoOk) {
        var avisos = (resp && resp.warnings) || [];
        if (avisos.length) {
            FTTH.toast('avis', textoOk, avisos.map(function (w) { return w.message; }));
        } else {
            FTTH.toast('ok', textoOk);
        }
    }

    /* ------------------------------------------------------------------ rota óptica */

    /**
     * O detalhe por trás da estimativa da ficha: de onde vem o sinal, cada salto com a sua
     * perda, e quanto chega nesta caixa.
     *
     * É o mesmo painel que o diagrama abre ao clicar numa ponta, aqui no tema claro e a
     * partir da caixa inteira — o servidor escolhe a ponta representativa pela mesma regra
     * que produziu a estimativa, então os dois números nunca discordam.
     *
     * A tela não soma dB nenhum: duas contas sempre divergem.
     */
    function abrirRota(caixaId, nome) {
        $('#rt-titulo').text('Rota óptica' + (nome ? ' · ' + nome : ''));
        $('#rt-corpo').html('<p class="ftth-sub">Calculando a rota…</p>');
        $('#modal-rota').show();

        FTTH.chamar({
            url: 'mapa.php?ajax=rota&caixa=' + caixaId,
            onOk:  function (d) { $('#rt-corpo').html(htmlRota(d)); },
            onErro: function (m) {
                // Caixa sem caminho até a OLT é estado normal da rede, não falha.
                $('#rt-corpo').html('<div class="ftth-aviso">' + esc(m) + '</div>');
            }
        });
    }

    function htmlRota(d) {
        var o = d.origem || {};

        var html = '<div class="ftth-rota-origem">'
            +   '<p class="ftth-ficha-secao"><i class="bi-hdd-rack-fill"></i> Origem do sinal</p>'
            +   '<p class="ftth-rota-caixa">' + esc(o.caixa || '—') + '</p>'
            +   '<dl class="ftth-ficha">'
            +     linha('Serviço', juntar([o.servico]))
            +     linha('Equipamento', juntar([o.olt, o.pon]))
            +     linha('DIO / Porta', juntar([o.dio, o.porta]))
            +     linha('Potência de saída', dbm(o.ptx_dbm))
            +   '</dl>'
            + '</div>'

            + '<div class="ftth-estimativa' + (d.classe ? ' ftth-estimativa--' + esc(d.classe) : '') + '">'
            +   '<span class="ftth-sub">Chega nesta caixa</span>'
            +   '<strong>' + dbm(d.dbm)
            +     (d.classe ? ' <small>' + esc(d.classe) + '</small>' : '') + '</strong>'
            +   '<span class="ftth-sub">medido na ' + esc(d.onde || 'fibra que chega') + '</span>'
            + '</div>'

            + '<p class="ftth-ficha-secao">Rota · ' + (d.passos || []).length + ' salto(s)</p>';

        // Os passos vêm lineares do servidor; aqui só se agrupa por caixa, que é como quem
        // lê pensa a rede: "no POP aconteceu isso, na CEO aquilo".
        var caixaAtual = null;
        (d.passos || []).forEach(function (s) {
            if (s.via === 'CABO') {
                html += '<div class="ftth-rota-cabo">'
                     +    '<i class="bi-arrow-down"></i> ' + esc(s.rotulo)
                     +    (s.km ? ' · ' + km(s.km) : '')
                     +    '<span class="ftth-rota-perda">−' + s.perda.toFixed(2) + ' dB</span>'
                     +  '</div>';
                caixaAtual = null;          // o próximo passo já é na caixa seguinte
                return;
            }

            if (s.caixa && s.caixa !== caixaAtual) {
                caixaAtual = s.caixa;
                html += '<div class="ftth-rota-caixa-salto">'
                     +    '<span>' + esc(s.caixa) + '</span>'
                     +    '<strong>' + dbm(s.dbm) + '</strong>'
                     +  '</div>';
            }

            html += '<div class="ftth-rota-salto">'
                 +    '<span class="ftth-rota-via">' + esc(rotuloVia(s.via)) + '</span>'
                 +    esc(s.rotulo)
                 +    '<span class="ftth-rota-perda">−' + s.perda.toFixed(2) + ' dB</span>'
                 +  '</div>';
        });

        return html;
    }

    var VIAS = {
        FUSAO:    'fusão',
        PASSAGEM: 'passagem',
        CONECTOR: 'conector',
        SPLITTER: 'splitter'
    };

    function rotuloVia(v) { return VIAS[v] || (v || '').toLowerCase(); }

    function km(v) {
        var n = parseFloat(v);
        if (isNaN(n)) return '';
        return n < 1 ? Math.round(n * 1000) + ' m' : n.toFixed(2).replace('.', ',') + ' km';
    }

    /** Item de quarentena: revisar e decidir aqui mesmo, sem sair do mapa (U1). */
    function abrirQuarentena(q) {
        var cfg = window.FTTH_MAPA || {};
        var alertas = (q.alertas || []).map(function (a) {
            return '<span class="ftth-selo ftth-selo--pend">' + esc(a.message) + '</span>';
        }).join(' ');

        var acoes = '<button class="ftth-btn ftth-btn--pri" id="q-importar" data-id="' + q.id + '">Importar para a rede</button> '
            + '<button class="ftth-btn ftth-btn--sec" id="q-descartar" data-id="' + q.id + '">Descartar</button>';

        painel('<h3 class="ftth-painel-titulo">' + esc(q.nome || '(sem nome)') + '</h3>'
            + '<p class="ftth-sub"><span class="ftth-selo ftth-selo--novo">não revisado</span> '
            + esc(q.tipo) + ' · ' + esc(q.subtipo || '') + '</p>'
            + (alertas ? '<p>' + alertas + '</p>' : '')
            + (q.tipo === 'VAO'
                ? '<p class="ftth-sub">Um cabo só entra depois das duas caixas das pontas.</p>'
                : '')
            + '<div id="q-acoes">' + acoes + '</div>'
            + '<div id="q-saida"></div>'
            + '<p class="ftth-sub" style="margin-top:10px"><a href="importar.php">Ver a lista completa</a></p>');
    }

    function decidirQuarentena(id, acao) {
        var cfg = window.FTTH_MAPA || {};
        $('#q-acoes button').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=' + (acao === 'importar' ? 'importar_item' : 'descartar_item'),
            method: 'POST',
            data: { csrf: cfg.csrf, id: id },
            onOk: function (d) {
                carregar();   // o item deixa de ser translúcido e vira rede
                if (acao === 'importar' && d && d.tipo === 'CAIXA' && d.id) {
                    // Já mostra a ficha da caixa recém-criada: o usuário continua no mesmo ponto,
                    // vendo o resultado, sem ter que clicar de novo no marcador.
                    abrirFicha(d.id);
                } else if (acao === 'importar') {
                    $('#q-acoes').html('<span class="ftth-selo ftth-selo--ok">Importado para a rede.</span>');
                } else {
                    $('#painel').hide();
                }
            },
            onErro: function (m) {
                $('#q-saida').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
                $('#q-acoes button').prop('disabled', false);
            }
        });
    }

    function buscar(termo) {
        if (termo.length < 2) { $('#busca-lista').hide(); return; }
        FTTH.chamar({
            url: 'mapa.php?ajax=buscar&regiao=' + regiao + '&q=' + encodeURIComponent(termo),
            onOk: function (d) {
                var html = '', grupo = '';
                d.resultados.forEach(function (r) {
                    if (r.grupo !== grupo) {
                        grupo = r.grupo;
                        html += '<div class="ftth-busca-grupo">' + esc(grupo) + '</div>';
                    }
                    html += '<div class="ftth-busca-item" data-lat="' + r.lat + '" data-lng="' + r.lng
                         +  '" data-id="' + r.id + '" data-tipo="' + r.tipo + '" data-instalacao="'
                         +  (r.instalacao_id || '') + '" data-conta="' + esc(r.tipo_conta || '')
                         +  '" data-login="' + esc(r.login || '') + '" data-bloqueado="'
                         +  (r.bloqueado ? '1' : '0') + '">'
                         +  '<strong>' + esc(r.rotulo) + '</strong> <span class="ftth-sub">' + esc(r.detalhe) + '</span>'
                         +  '</div>';
                });
                $('#busca-lista').html(html || '<div class="ftth-busca-item ftth-sub">Nada encontrado.</div>').show();
            },
            onErro: function () { $('#busca-lista').hide(); }
        });
    }

    /** O mapa ocupa tudo o que sobra da janela — nada de altura fixa chutada. */
    function ajustarAltura() {
        var el = document.getElementById('mapa');
        if (!el) return;
        // A folga é só a do padding de baixo do wrap (6px): o mapa encosta na borda da
        // janela. Qualquer valor a mais aqui vira faixa cinza inútil embaixo do mapa.
        var topo = el.getBoundingClientRect().top;
        var altura = Math.max(360, window.innerHeight - topo - 6);
        el.style.height = altura + 'px';
    }

    /* ------------------------------------------------------------------ traçado de cabo */

    /**
     * Regra do traçado (I1): começa numa caixa, passa por quantos vértices e caixas quiser,
     * e termina numa caixa. Cada trecho entre duas caixas vira um vão no servidor.
     */
    function iniciarTracado() {
        limparTracado();
        $('#cabo-card').show();
        atualizarTracado();
        ajustarToasts();
        avisarMudanca();
    }

    /**
     * Em tela estreita os cards de Cabo e Mover ficam na base do mapa, justamente onde o toast
     * nasce. Enquanto um deles estiver aberto, o toast sobe e aparece logo acima do card.
     */
    function ajustarToasts() {
        var raiz = document.documentElement;
        var estreita = window.matchMedia && window.matchMedia('(max-width: 470px)').matches;
        var card = $('#cabo-card:visible, #mover-card:visible, #medir-card:visible, #regiao-card:visible, #sel-card:visible, #sel-barra:visible').get(0);
        if (estreita && card) {
            var topo = card.getBoundingClientRect().top;
            raiz.style.setProperty('--ftth-toast-base', Math.max(20, window.innerHeight - topo + 8) + 'px');
        } else {
            raiz.style.removeProperty('--ftth-toast-base');
        }
    }

    function limparTracado() {
        tracado = [];
        if (linhaTracado) { linhaTracado.setMap(null); linhaTracado = null; }
        pinosTracado.forEach(function (p) { p.setMap(null); });
        pinosTracado = [];
        $('#cabo-card').hide();
        ajustarToasts();
    }

    function pontoTracado(p) {
        tracado.push(p);
        atualizarTracado();
    }

    /** O traçado já ancorou no destino do primeiro cabo? Aí ele para de pular. */
    function destinoAlcancado() {
        return tracado.some(function (p) {
            return p.tipo === 'CAIXA' && Number(p.id) === pontoEmDestaque;
        });
    }

    /** Liga ou desliga o pulo conforme o traçado: ancorou, para; o Desfazer tirou, volta. */
    function atualizarPulo() {
        if (!pontoEmDestaque) return;
        var parar = destinoAlcancado();
        marcadores.forEach(function (m) {
            if (m.ftthCaixaId !== pontoEmDestaque) return;
            var pulando = m.getAnimation() === google.maps.Animation.BOUNCE;
            if (parar && pulando) m.setAnimation(null);
            if (!parar && !pulando) m.setAnimation(google.maps.Animation.BOUNCE);
        });
    }

    function atualizarTracado() {
        var caminho = tracado.map(function (p) { return { lat: p.lat, lng: p.lng }; });
        var cfg = window.FTTH_MAPA || {};
        var espessura = parseInt($('#cb-espessura').val(), 10) || parseInt(cfg.cabo_espessura, 10) || 5;

        if (linhaTracado) { linhaTracado.setMap(null); }
        if (caminho.length > 1) {
            // Em edição o cabo é pontilhado — deixa claro que ainda não existe na rede.
            linhaTracado = new google.maps.Polyline({
                path: caminho, map: mapa,
                strokeOpacity: 0,
                icons: [{
                    icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeWeight: espessura, scale: 3,
                            strokeColor: corCaboSelecionada() },
                    offset: '0', repeat: '14px'
                }]
            });
        }

        pinosTracado.forEach(function (p) { p.setMap(null); });
        pinosTracado = tracado.map(function (p, i) {
            return new google.maps.Marker({
                position: { lat: p.lat, lng: p.lng }, map: mapa, zIndex: 998,
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: p.tipo === 'CAIXA' ? 7 : 5,
                    fillColor: p.tipo === 'CAIXA' ? '#1B3A6B' : '#FFFFFF',
                    fillOpacity: 1, strokeColor: '#1B3A6B', strokeWeight: 2
                },
                title: p.tipo === 'CAIXA' ? ('Caixa: ' + (p.nome || '')) : ('Ponto ' + (i + 1))
            });
        });

        var caixas = tracado.filter(function (p) { return p.tipo === 'CAIXA'; }).length;
        $('#cabo-contagem').text(tracado.length + ' ponto' + (tracado.length === 1 ? '' : 's')
            + ' · ' + caixas + ' caixa' + (caixas === 1 ? '' : 's'));

        atualizarFinalizar();
        atualizarPulo();
        // Desde a 0.9.6 as pontas podem ficar no vazio: viram ponta livre, onde um ponto
        // pode ser solto depois.
        $('#cabo-dica').text(!tracado.length
            ? 'Clique numa caixa ou no mapa onde o cabo começa.'
            : (tracado.length === 1
                ? 'Siga clicando na rua, ou numa caixa para ancorar.'
                : 'Siga clicando, ou finalize: ponta sem caixa vira ponta livre.'));
    }

    function corCaboSelecionada() {
        if (continuando) return continuando.cor;
        return $('#cb-cores .ftth-cor.ativo').data('cor') || '#00E676';
    }

    /** "Continuar cabo": o traçado já sai da ponta, na cor do cabo, sem o ⚙ de configuração. */
    function iniciarContinuacao() {
        iniciarTracado();
        $('#cabo-config').hide();
        $('#cabo-titulo').text('Continuando ' + continuando.nome + ' · ' + continuando.tipo);
        pontoTracado(caboDesde);
    }

    function finalizarTracado() {
        if (!podeFinalizarCabo()) {
            FTTH.toast('erro', 'Marque ao menos o início e o fim do cabo.');
            return;
        }
        // A configuração já veio antes do desenho: finalizar é gravar.
        salvarCabo();
    }

    /**
     * Finalizar acende com dois pontos marcados — o mesmo que o servidor exige. As pontas sem
     * caixa viram ponta livre (0.9.6); antes o cabo tinha de começar e terminar em caixa.
     */
    function podeFinalizarCabo() {
        return tracado.length >= 2;
    }

    function atualizarFinalizar() {
        $('#cabo-finalizar').prop('disabled', !podeFinalizarCabo())
            .attr('title', podeFinalizarCabo() ? '' : 'Marque ao menos o início e o fim do cabo');
    }

    function desenhandoCabo() { return $('#cabo-card').is(':visible'); }

    /**
     * Passo 1 do modo Cabo: o popup. Na entrada ele pede para desenhar; reaberto pelo ⚙ do
     * card, só volta para o traçado — e a cor trocada ali já pinta o que está desenhado.
     */
    function abrirConfigCabo() {
        var desenhando = desenhandoCabo();
        $('#cabo-modal-titulo').text(desenhando ? 'Configuração do cabo' : 'Novo cabo');
        $('#cb-salvar').text(desenhando ? 'Continuar desenhando' : 'Desenhar');
        var caixas = tracado.filter(function (p) { return p.tipo === 'CAIXA'; }).length;
        $('#cabo-resumo').text(desenhando
            ? tracado.length + ' ponto(s) marcados · ' + caixas + ' caixa(s). O traçado continua na tela.'
            : 'Configure e desenhe. Ponta sem caixa vira ponta livre, onde um ponto pode entrar depois.');
        $('#cb-espessura-area').toggle(!continuando);
        $('#cb-espessura-continuacao').toggle(!!continuando);
        $('#cb-saida').empty();
        $('#modal-cabo').show();
        setTimeout(function () { $('#cb-nome').trigger('focus'); }, 50);
    }

    function confirmarConfigCabo() {
        $('#modal-cabo').hide();
        if (desenhandoCabo()) {
            atualizarTracado();                  // a cor pode ter mudado
            return;
        }
        iniciarTracado();
        if (caboDesde) {
            pontoTracado(caboDesde);             // primeiros passos: o cabo já sai do POP
        } else {
            FTTH.toast('info', 'Clique numa caixa ou no mapa onde o cabo começa.');
        }
    }

    function salvarCabo() {
        var cfg = window.FTTH_MAPA || {};
        $('#cabo-finalizar').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=novo_cabo',
            method: 'POST',
            data: {
                csrf: cfg.csrf, regiao: regiao,
                nome: $('#cb-nome').val(), fabricante: $('#cb-fabricante').val(),
                cabo_tipo_id: $('#cb-tipo').val(), padrao_cores: $('#cb-padrao').val(),
                cor_rota: corCaboSelecionada(), espessura_mapa: $('#cb-espessura').val(),
                continuar_de: continuando ? continuando.ponta : 0,
                pontos: JSON.stringify(tracado.map(function (p) {
                    return p.tipo === 'CAIXA'
                        ? { tipo: 'CAIXA', id: p.id }
                        : { tipo: 'VERTICE', lat: p.lat, lng: p.lng };
                }))
            },
            onOk: function (d) {
                limparTracado();
                $('#cb-nome').val(''); $('#cb-fabricante').val('');
                $('#cb-espessura').val('');
                // Gravou: o desenho acabou e o mapa volta para o modo Navegar. Antes o modo
                // Cabo continuava ligado sem o card na tela, e o próximo traçado começava
                // sem contador, sem dica e sem os botões.
                definirModo('navegar');
                // A troca de modo não redesenha sozinha (só a entrada no modo edição faz
                // isso), e sem esta linha o cabo recém-criado só aparecia no próximo
                // movimento do mapa.
                carregar();
                FTTH.toast('ok', d.continuado
                    ? 'Cabo continuado a partir da ponta livre: agora com ' + Math.round(d.metros) + ' m.'
                    : d.tipo + ' criado: ' + d.vaos.length + ' vão(s), ' + Math.round(d.metros) + ' m.');
            },
            // O traçado continua na tela: o usuário corrige (⚙ ou Desfazer) e finaliza de novo.
            onErro: function (m) { FTTH.toast('erro', m); }
        }).always(atualizarFinalizar);
    }

    /* ------------------------------------------------------------------ nova caixa */

    /**
     * Fluxo do modo Caixa: primeiro o usuário marca o ponto no mapa, depois configura.
     * Assim ele vê exatamente onde a caixa vai ficar antes de dar nome a ela.
     */
    function definirModo(novo) {
        // Sair do modo Mover com alterações na tela perderia trabalho em silêncio: nada
        // foi gravado ainda, então a saída pergunta antes.
        if (modo === 'mover' && novo !== 'mover' && contarPendentes() > 0
            && !confirm('Há alterações não concluídas no mapa.\n\nSair agora descarta tudo.')) {
            return;
        }
        if (modo === 'mover' && novo !== 'mover') {
            sairDoModoMover();
        }
        if (modo === 'selecionar' && novo !== 'selecionar') {
            limparSelecao();
            $('#sel-card, #sel-barra, #modal-lote, #modal-cor-lote').hide();
        }
        if (modo === 'medir' && novo !== 'medir') {
            limparMedicao();
            $('#medir-card').hide();
        }

        modo = novo;
        $('.ftth-modo').removeClass('ativo');
        $('.ftth-modo[data-modo="' + novo + '"]').addClass('ativo');
        if (mapa) {
            mapa.setOptions({
                draggableCursor: modoDeDesenho(novo) ? 'crosshair' : null
            });
            // A mãozinha em cima do cabo promete abrir a ficha. Nos modos de desenho o
            // clique ali marca ponto, então o cursor tem de dizer a mesma coisa que o mapa.
            linhas.forEach(function (l) { l.setOptions({ cursor: cursorDoCabo() }); });
            desenharClientesMapa(clientesMapaDados);
        }

        // Os presets dos primeiros passos valem só para o modo que os pediu.
        if (novo !== 'caixa') presetPonto = null;
        if (novo !== 'cabo' && (caboDesde || pontoEmDestaque)) {
            caboDesde = null;
            pontoEmDestaque = 0;
            if (ultimoDesenho) desenhar(ultimoDesenho);   // para de pular
        }

        if (novo === 'caixa') {
            // Com o assistente na tela a dica já está no balão; o toast repetiria a frase.
            if (!presetPonto) FTTH.toast('info', 'Clique no mapa para marcar o ponto.');
        } else if (novo === 'cabo') {
            if (continuando) {
                iniciarContinuacao();   // mesmo cabo: nada a configurar
            } else {
                abrirConfigCabo();      // configura primeiro; o traçado começa no "Desenhar"
            }
        } else if (novo === 'selecionar') {
            $('#painel').hide();
            iniciarSelecao();
        } else if (novo === 'mover') {
            if (linhaAtivaMover) {
                linhaAtivaMover.setEditable(false);
                restaurarEstiloVaoMover(linhaAtivaMover);
            }
            vaoAtivoMoverId = null;
            linhaAtivaMover = null;
            limparSelecaoPontaMover();
            $('#mover-vinculo-abrir').hide();
            FTTH.toast('info', 'Selecione um cabo. Use “Vincular ponto no trecho” para conectar uma CTO ou outro ponto existente no meio.');
            $('#mover-card').show();
            ajustarToasts();
            atualizarContaMover();
            carregar();                 // redesenha com os marcadores arrastáveis
        } else if (novo === 'medir') {
            limparMedicao();
            $('#medir-card').show();
            ajustarToasts();
        } else {
            $('#cabo-dica').text('');
        }

        if (novo !== 'caixa') {
            limparPin();
            $('#modal-caixa').hide();
        }
        if (novo !== 'cabo') {
            limparTracado();
            $('#modal-cabo').hide();
            continuando = null;
            $('#cabo-config').show();
            $('#cabo-titulo').text('Traçando cabo');
        }
        avisarMudanca();
    }

    /* ------------------------------------------------------------------ modo Selecionar */

    /*
     * Passo 1: cada clique é um canto da área (padrão UpperX). Passo 2, depois do Concluir
     * área: o servidor devolve o que ficou dentro (Lote::previa) e a barra de baixo oferece as
     * ações. Clicar num ponto tira ou põe ele na seleção, e a prévia é refeita no servidor —
     * a tela nunca calcula sozinha o que sai, para o que ela mostra ser o que o banco faz.
     */
    // Magenta: não existe na imagem de satélite (árvore, telhado, asfalto, terra) nem na paleta
    // de cabos. O verde de antes sumia no meio das árvores (30/09/2026).
    var COR_AREA = '#FF2BD6';
    var COR_SAI  = '#FF5252';     // cabo que vai sair: o vermelho é o aviso antes do botão

    function iniciarSelecao() {
        limparSelecao();
        $('#sel-barra').hide();
        $('#sel-card').show();
        avisarFiltroSelecao();
        atualizarArea();
        ajustarToasts();
    }

    function limparSelecao() {
        areaSel = [];
        if (areaPoligono) { areaPoligono.setMap(null); areaPoligono = null; }
        areaPinos.forEach(function (p) { p.setMap(null); });
        areaPinos = [];
        selecao = null;
        destacarSelecao();
    }

    function verticeDaArea(latLng) {
        areaSel.push(latLng);
        atualizarArea();
    }

    function atualizarArea() {
        var n = areaSel.length;
        if (!areaPoligono && n) {
            areaPoligono = new google.maps.Polygon({
                map: mapa, strokeColor: COR_AREA, strokeOpacity: 0.95, strokeWeight: 2,
                fillColor: COR_AREA, fillOpacity: 0.18, zIndex: 1
            });
            // Clique dentro da área continua marcando canto: o polígono fica por cima do
            // mapa e, sem isto, engoliria o clique.
            areaPoligono.addListener('click', cliqueNoMapa);
        }
        if (areaPoligono) areaPoligono.setPaths(areaSel);

        areaPinos.forEach(function (p) { p.setMap(null); });
        areaPinos = areaSel.map(function (p) {
            return new google.maps.Marker({
                position: p, map: mapa, clickable: false, zIndex: Z_CAIXA + 50,
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: 4.5, fillColor: '#fff',
                        fillOpacity: 1, strokeColor: COR_AREA, strokeWeight: 2 }
            });
        });

        $('#sel-conta').text(plural(n, 'ponto', 'pontos'));
        $('#sel-dica').text(n < 3 ? 'Clique no mapa para marcar os cantos da área.'
                                  : 'Feche a área com Concluir área.');
        $('#sel-desfazer').prop('disabled', n === 0);
        $('#sel-concluir').prop('disabled', n < 3);
    }

    function concluirArea() {
        if (areaSel.length < 3) return;
        var cfg = window.FTTH_MAPA || {};
        var $b = $('#sel-concluir').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=selecionar',
            method: 'POST',
            data: { csrf: cfg.csrf, regiao: regiao, tipos: JSON.stringify(tiposVisiveis()),
                    com_cabos: camadas.CABOS ? 1 : 0,
                    poligono: JSON.stringify(areaSel.map(function (p) { return [p.lat(), p.lng()]; })) },
            onOk: aplicarSelecao,
            onErro: function (m) { FTTH.toast('erro', m); $b.prop('disabled', false); }
        });
    }

    /** A prévia do servidor vira o destaque no mapa e a barra de baixo. */
    function aplicarSelecao(d) {
        if (!d.caixas.length && !d.protegidas.length && !d.cabos_sel.length) {
            FTTH.toast('info', 'Nenhum ponto ou cabo dentro da área'
                + ($('.ftth-sel-filtro').first().text() ? ' nas camadas visíveis' : '')
                + '. Ajuste os cantos ou desenhe outra.');
            $('#sel-concluir').prop('disabled', areaSel.length < 3);
            selecao = null;
            destacarSelecao();
            return;
        }
        if (d.protegidas.length && (!selecao || selecao.protegidas.length !== d.protegidas.length)) {
            FTTH.toast('info', 'DC/POP não é excluído em lote (' + d.protegidas.map(function (c) {
                return c.nome; }).join(', ') + '). Exclua pela ficha, se for o caso.');
        }
        selecao = d;
        if (areaPoligono) areaPoligono.setOptions({ fillOpacity: 0.06, clickable: false });
        areaPinos.forEach(function (p) { p.setMap(null); });
        areaPinos = [];

        $('#sel-card').hide();
        $('#sel-n-caixas').text(d.caixas.length);
        $('#sel-n-cabos').text(d.cabos.length);
        $('#sel-excluir').prop('disabled', !d.caixas.length && !d.cabos_sel.length);
        $('#sel-barra').show();
        ajustarToasts();
        destacarSelecao();
    }

    /** Clique num ponto: durante o desenho é um canto; com a seleção feita, tira ou põe. */
    function cliqueSelecionar(c, pos) {
        if (!selecao) {
            verticeDaArea(pos);
            return;
        }
        var id = Number(c.id);
        var ids = selecao.caixas.concat(selecao.protegidas).map(function (x) { return Number(x.id); });
        var i = ids.indexOf(id);
        if (i >= 0) ids.splice(i, 1); else ids.push(id);
        refazerPrevia(ids, idsCabosSel());
    }

    /** Clique num cabo com a seleção feita: tira ou põe o cabo inteiro. */
    function cliqueCaboSelecionar(caboId) {
        var cabos = idsCabosSel();
        var i = cabos.indexOf(Number(caboId));
        if (i >= 0) cabos.splice(i, 1); else cabos.push(Number(caboId));
        refazerPrevia(idsPontosSel(), cabos);
    }

    function idsPontosSel() {
        return selecao ? selecao.caixas.concat(selecao.protegidas).map(function (x) { return Number(x.id); }) : [];
    }
    function idsCabosSel() {
        return selecao ? selecao.cabos_sel.map(function (x) { return Number(x.id); }) : [];
    }

    /** Prévia de uma seleção ajustada (clique, camada desligada). Vazia: volta a desenhar. */
    function refazerPrevia(ids, cabos) {
        var cfg = window.FTTH_MAPA || {};
        FTTH.chamar({
            url: 'mapa.php?ajax=selecionar',
            method: 'POST',
            data: { csrf: cfg.csrf, regiao: regiao, caixas: JSON.stringify(ids),
                    cabos: JSON.stringify(cabos || []) },
            onOk: function (d) {
                if (!d.caixas.length && !d.protegidas.length && !d.cabos_sel.length) {
                    iniciarSelecao();       // tirou o último: volta a desenhar
                    return;
                }
                aplicarSelecao(d);
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        });
    }

    /**
     * Camada mexida no modo Selecionar. Com a seleção já feita, o tipo que sumiu da tela sai
     * dela — Cor e Excluir nunca podem alcançar o que não está à vista. Ligar uma camada não
     * acrescenta nada: o que entra é decidido pela área, com Nova área.
     */
    function camadaNaSelecao() {
        avisarFiltroSelecao();
        if (!selecao) return;
        var todas = selecao.caixas.concat(selecao.protegidas);
        var ficam = todas.filter(function (c) { return visivel(c.tipo); });
        var cabos = camadas.CABOS ? idsCabosSel() : [];
        var saem = (todas.length - ficam.length) + (selecao.cabos_sel.length - cabos.length);
        if (!saem) return;
        FTTH.toast('info', plural(saem, 'item saiu', 'itens saíram') + ' da seleção: a camada foi desligada.');
        if (!ficam.length && !cabos.length) { iniciarSelecao(); return; }
        refazerPrevia(ficam.map(function (c) { return Number(c.id); }), cabos);
    }

    /** Anel nos pontos que saem e vermelho nos cabos que saem. Roda a cada redesenho. */
    function destacarSelecao() {
        selAneis.forEach(function (a) { a.setMap(null); });
        selAneis = [];
        var caixas = {}, vaos = {};
        if (selecao) {
            selecao.caixas.forEach(function (c) { caixas[c.id] = true; });
            selecao.vaos.forEach(function (id) { vaos[id] = true; });
        }
        marcadores.forEach(function (m) {
            if (!caixas[m.ftthCaixaId]) return;
            selAneis.push(new google.maps.Marker({
                position: m.getPosition(), map: mapa, clickable: false, zIndex: Z_CAIXA - 1,
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: 19, strokeColor: COR_AREA,
                        strokeWeight: 3, fillColor: COR_AREA, fillOpacity: 0.2 }
            }));
        });
        linhas.forEach(function (l) {
            var sai = !!vaos[l.ftthVaoId];
            l.setOptions({ strokeColor: sai ? COR_SAI : l.ftthCor, zIndex: sai ? Z_CABO + 1 : Z_CABO });
        });
    }

    function abrirExclusaoLote() {
        if (!selecao || (!selecao.caixas.length && !selecao.cabos_sel.length)) return;
        var r = selecao.resumo;
        var tipos = Object.keys(r.por_tipo).map(function (t) {
            return r.por_tipo[t] + ' ' + (ROTULO_TIPO[t] || t);
        }).join(', ');
        var li = function (rotulo, valor, alerta) {
            return '<li' + (alerta ? ' class="alerta"' : '') + '><span>' + rotulo + '</span><b>'
                 + valor + '</b></li>';
        };
        var cabos = [];
        if (r.cabos_excluidos) cabos.push(r.cabos_excluidos + ' inteiro(s)');
        if (r.cabos_encurtados) cabos.push(r.cabos_encurtados + ' encurtado(s)');
        if (r.cabos_partidos) cabos.push(r.cabos_partidos + ' partido(s) em dois');

        var html = '<p class="ftth-sub" style="margin:0 0 8px">Sai do mapa e continua no histórico. '
                 + (r.caixas ? 'Cabo que liga um ponto de dentro a um de fora sai inteiro até o ponto de fora. ' : '')
                 + (r.cabos_sel ? 'Cabo selecionado sai inteiro, mesmo a parte fora da área.' : '') + '</p>'
                 + '<ul class="ftth-lote-lista">'
                 + (r.caixas ? li('Pontos' + (tipos ? ' <small>(' + esc(tipos) + ')</small>' : ''), r.caixas) : '')
                 + (r.cabos_sel ? li('Cabos selecionados', r.cabos_sel) : '')
                 + (r.vaos ? li('Trechos de cabo', r.vaos + (cabos.length ? ' <small>· ' + cabos.join(', ')
                                + '</small>' : '')) : '')
                 + (r.reservas ? li('Reservas nos trechos', r.reservas) : '')
                 + (r.ligacoes ? li('Fusões desfeitas', r.ligacoes) : '')
                 + (r.splitters ? li('Splitters', r.splitters) : '')
                 + (r.clientes ? li('Clientes desvinculados', r.clientes, true) : '')
                 + '</ul>';
        if (selecao.ligacoes_fora.length) {
            html += '<div class="ftth-lote-detalhe">Fusões em pontos que <b>ficam</b>, porque a fibra '
                  + 'delas sai junto:<ul>' + selecao.ligacoes_fora.map(function (x) {
                      return '<li>' + esc(x.caixa) + ' — ' + plural(x.ligacoes, 'fusão', 'fusões') + '</li>';
                  }).join('') + '</ul></div>';
        }
        if (selecao.clientes.length) {
            html += '<div class="ftth-aviso ftth-aviso--erro" style="margin:0 0 10px">'
                  + '<b>' + plural(selecao.clientes.length, 'cliente perde', 'clientes perdem')
                  + ' a porta:</b><ul style="margin:4px 0 0 16px;padding:0;max-height:140px;overflow:auto">'
                  + selecao.clientes.map(function (c) {
                      return '<li>' + esc(c.login) + ' — ' + esc(c.caixa) + ' / ' + esc(c.splitter)
                           + ' porta ' + c.porta + (c.identificacao ? ' · ' + esc(c.identificacao) : '') + '</li>';
                  }).join('') + '</ul></div>';
        }
        $('#lote-previa').html(html);
        $('#lote-confirma').toggle(selecao.clientes.length > 0);
        $('#lote-confirmacao').val('');
        $('#lote-saida').empty();
        $('#lote-excluir').prop('disabled', false);
        $('#modal-lote').show();
        if (selecao.clientes.length) setTimeout(function () { $('#lote-confirmacao').trigger('focus'); }, 50);
    }

    /* ------------------------------------------------------------------ exportar KMZ */

    /**
     * Baixa o KMZ. Não dá para usar o FTTH.chamar: a resposta boa é um ARQUIVO, e só a ruim é
     * JSON. O fetch olha o Content-Type e decide — erro nunca vira um .kmz corrompido.
     */
    function baixarKmz(dados, $botao, aoTerminar) {
        var fd = new FormData();
        fd.append('csrf', (window.FTTH_MAPA || {}).csrf);
        fd.append('regiao', regiao);
        Object.keys(dados).forEach(function (k) { fd.append(k, dados[k]); });
        var htmlBotao = $botao.html();
        $botao.prop('disabled', true).html('<i class="bi-hourglass-split"></i> Gerando…');
        var fim = function () { $botao.prop('disabled', false).html(htmlBotao); };

        fetch('mapa.php?ajax=exportar_kmz', { method: 'POST', body: fd, credentials: 'same-origin' })
            .then(function (r) {
                if ((r.headers.get('Content-Type') || '').indexOf('json') >= 0) {
                    return r.json().then(function (j) {
                        throw new Error(((j.errors || [])[0] || {}).message || 'Não foi possível exportar.');
                    });
                }
                var m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
                return r.blob().then(function (b) {
                    var url = URL.createObjectURL(b);
                    var a = document.createElement('a');
                    a.href = url;
                    a.download = m ? m[1] : 'ftth.kmz';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
                    fim();
                    FTTH.toast('ok', 'Arquivo ' + a.download + ' baixado.');
                    if (aoTerminar) aoTerminar();
                });
            })
            .catch(function (e) { fim(); FTTH.toast('erro', e.message); });
    }

    var timerContaExp = null;

    function dadosExportacao() {
        var tipos = $('.exp-tipo:checked').map(function () { return this.value; }).get();
        return {
            tipos: JSON.stringify(tipos.filter(function (t) { return t !== 'CABOS'; })),
            cabos: tipos.indexOf('CABOS') >= 0 ? '1' : '0',
            todas: $('#exp-todas').is(':checked') ? '1' : '0'
        };
    }

    /** Os checkboxes nascem como as camadas ligadas: o que se vê é o que se costuma querer. */
    function abrirExportar() {
        var camadaDe = { POSTE: 'POSTES' };
        $('.exp-tipo').each(function () {
            this.checked = camadas[camadaDe[this.value] || this.value] !== false;
        });
        $('#exp-todas').prop('checked', false);
        $('#exp-saida').empty();
        $('#modal-exportar').show();
        contarExportacao();
    }

    function contarExportacao() {
        var faltando = $('.exp-tipo:not(:checked)').length;
        $('#exp-todos').text(faltando ? 'Marcar todos' : 'Desmarcar todos');
        $('#exp-baixar').prop('disabled', true);
        $('#exp-conta').text('Contando…');
        clearTimeout(timerContaExp);
        timerContaExp = setTimeout(function () {
            FTTH.chamar({
                url: 'mapa.php?ajax=exportar_contar',
                method: 'POST',
                data: $.extend({ csrf: (window.FTTH_MAPA || {}).csrf, regiao: regiao }, dadosExportacao()),
                onOk: function (d) {
                    $('#exp-conta').text(d.pontos || d.vaos
                        ? plural(d.pontos, 'ponto', 'pontos') + ' e ' + plural(d.vaos, 'trecho de cabo', 'trechos de cabo') + '.'
                        : 'Nada a exportar com essa escolha.');
                    $('#exp-baixar').prop('disabled', !(d.pontos || d.vaos));
                },
                onErro: function (m) { $('#exp-conta').text(m); }
            });
        }, 200);
    }

    /** Botão Exportar da seleção: exatamente os pontos e cabos selecionados. Baixou: volta a Navegar. */
    function exportarSelecao() {
        if (!selecao) return;
        baixarKmz({ caixas: JSON.stringify(idsPontosSel()), cabos_sel: JSON.stringify(idsCabosSel()) },
                  $('#sel-exportar'), function () { definirModo('navegar'); });
    }

    /**
     * Botão Cor da seleção: a paleta do cadastro para os pontos e a de rota para os cabos.
     * Cada paleta só aparece se a seleção tem aquilo; lado sem cor escolhida fica como está.
     */
    function abrirCorLote() {
        if (!selecao) return;
        var n = selecao.caixas.length + selecao.protegidas.length;
        var nc = selecao.cabos_sel.length;
        var partes = [];
        if (n) partes.push(plural(n, 'ponto selecionado', 'pontos selecionados'));
        if (nc) partes.push(plural(nc, 'cabo selecionado', 'cabos selecionados'));
        $('#lc-texto').text('Pinta ' + partes.join(' e ') + '.'
            + (n && nc ? ' Escolha uma cor ou as duas; o que ficar sem cor não muda.' : ''));
        $('#lc-bloco-pontos').toggle(n > 0);
        $('#lc-bloco-cabos').toggle(nc > 0);
        $('#lc-cores .ftth-cor, #lc-cores-cabo .ftth-cor').removeClass('ativo');
        $('#lc-saida').empty();
        $('#lc-aplicar').prop('disabled', true);
        $('#modal-cor-lote').show();
    }

    function aplicarCorLote() {
        var cor = $('#lc-cores .ftth-cor.ativo').data('cor') || '';
        var corCabo = $('#lc-cores-cabo .ftth-cor.ativo').data('cor') || '';
        if (!selecao || (!cor && !corCabo)) return;
        var cfg = window.FTTH_MAPA || {};
        var $b = $('#lc-aplicar').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=cor_lote',
            method: 'POST',
            data: { csrf: cfg.csrf, regiao: regiao, caixas: JSON.stringify(idsPontosSel()), cor: cor,
                    cabos: JSON.stringify(idsCabosSel()), cor_cabo: corCabo },
            onOk: function (d) {
                $('#modal-cor-lote').hide();
                var feitos = [];
                if (cor) feitos.push(plural(d.alterados, 'ponto pintado', 'pontos pintados'));
                if (corCabo) feitos.push(plural(d.cabos_alterados, 'cabo pintado', 'cabos pintados'));
                FTTH.toast('ok', feitos.join(' e ') + '.');
                definirModo('navegar');   // pintou: a seleção acabou, como no Excluir
                carregar();
            },
            onErro: function (m) {
                $('#lc-saida').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
                $b.prop('disabled', false);
            }
        });
    }

    function confirmarExclusaoLote() {
        if (!selecao) return;
        if (selecao.clientes.length && $.trim($('#lote-confirmacao').val()).toUpperCase() !== 'EXCLUIR') {
            $('#lote-saida').html('<div class="ftth-aviso ftth-aviso--erro">Digite EXCLUIR para confirmar.</div>');
            $('#lote-confirmacao').trigger('focus');
            return;
        }
        var cfg = window.FTTH_MAPA || {};
        var $b = $('#lote-excluir').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=excluir_lote',
            method: 'POST',
            data: { csrf: cfg.csrf, regiao: regiao,
                    caixas: JSON.stringify(selecao.caixas.map(function (c) { return c.id; })),
                    cabos: JSON.stringify(idsCabosSel()),
                    confirmacao: $('#lote-confirmacao').val() },
            onOk: function (d, resp) {
                var r = d.resumo;
                var feitos = [];
                if (r.caixas) feitos.push(plural(r.caixas, 'ponto', 'pontos'));
                if (r.cabos_sel) feitos.push(plural(r.cabos_sel, 'cabo', 'cabos'));
                if (r.vaos) feitos.push(plural(r.vaos, 'trecho de cabo', 'trechos de cabo'));
                $('#modal-lote').hide();
                mostrarAvisos(resp, 'Excluídos: ' + feitos.join(', ') + '.');
                definirModo('navegar');   // excluiu: a seleção acabou (limpa a área e os cards)
                carregar();
            },
            // Nada foi gravado — é uma transação só —, então a seleção continua na tela.
            onErro: function (m) {
                $('#lote-saida').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
                $b.prop('disabled', false);
            }
        });
    }

    /* ------------------------------------------------------------------ modo Mover */

    function dicaVaoMover(v) {
        var nome = (v.cabo_nome ? '"' + v.cabo_nome + '" · ' : '')
            + (v.nome_ini || 'ponta') + ' → ' + (v.nome_fim || 'ponta');
        $('#mover-dica').text('Editando ' + nome + '. Use as pontas circulares para conectar ou soltar; para ligar um ponto existente no meio, use “Vincular ponto no trecho”; '
            + 'arraste os vértices para ajustar a rota.');
    }

    function selecionarVaoMover(linha, v) {
        if (modo !== 'mover') return;
        if (linhaAtivaMover && linhaAtivaMover !== linha) {
            linhaAtivaMover.setEditable(false);
            restaurarEstiloVaoMover(linhaAtivaMover);
            limparFocoVerticeRotaMover();
        }
        if (Number(vaoAtivoMoverId) !== Number(v.id)) {
            limparSelecaoPontaMover();
        }
        vaoAtivoMoverId = Number(v.id);
        linhaAtivaMover = linha;
        tornarEditavel(linha, v);
        destacarEstiloVaoMover(linha);
        renderizarPainelRotaMover(linha, v);
        $('#mover-vinculo-abrir').toggle(!vinculoMeioMover);
        dicaVaoMover(v);
        desenharAlcasPontasMover(v);
        if (pontaSelecionadaMover && pontaSelecionadaMover.previa) {
            mostrarPontaSelecionadaMover(pontaSelecionadaMover.previa);
        }
    }

    function destacarEstiloVaoMover(linha) {
        linha.setOptions({
            icons: [{
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 2.6,
                    fillColor: '#E53935',
                    fillOpacity: 1,
                    strokeColor: '#E53935',
                    strokeWeight: 0
                },
                offset: '0',
                repeat: '12px'
            }],
            strokeWeight: Math.max(1, Math.min(linha.ftthPeso, 3)),
            strokeOpacity: 0.24,
            zIndex: Z_CABO + 20
        });
    }

    function restaurarEstiloVaoMover(linha) {
        if (!linha) return;
        linha.setOptions({
            icons: [],
            strokeColor: linha.ftthCor,
            strokeWeight: linha.ftthPeso,
            strokeOpacity: linha.ftthOpacidade,
            zIndex: Z_CABO
        });
    }

    function pontosDaLinhaRotaMover(linha) {
        var pontos = [];
        if (!linha) return pontos;
        linha.getPath().forEach(function (p) { pontos.push([p.lat(), p.lng()]); });
        return pontos;
    }

    function comprimentoRotaMover(pontos) {
        var raioTerra = 6371008.8, total = 0;
        for (var i = 1; i < pontos.length; i++) {
            var lat1 = Number(pontos[i - 1][0]) * Math.PI / 180;
            var lat2 = Number(pontos[i][0]) * Math.PI / 180;
            var dLat = lat2 - lat1;
            var dLng = (Number(pontos[i][1]) - Number(pontos[i - 1][1])) * Math.PI / 180;
            var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
            a = Math.max(0, Math.min(1, a));
            total += raioTerra * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }
        return total;
    }

    function atualizarComprimentoRotaMover(linha) {
        var total = comprimentoRotaMover(pontosDaLinhaRotaMover(linha));
        var texto = total >= 1000
            ? (total / 1000).toFixed(2).replace('.', ',') + ' km'
            : Math.round(total) + ' m';
        $('#ftth-rota-comprimento').text(texto);
    }

    function renderizarExtremoRotaMover($lista, v, lado) {
        var inicial = lado === 'ini';
        var nome = inicial ? v.caixa_ini : v.caixa_fim;
        var tipo = inicial ? v.caixa_ini_tipo : v.caixa_fim_tipo;
        var $linha = $('<div>').addClass('ftth-rota-extremo');
        var $info = $('<div>').addClass('ftth-rota-extremo-info');
        $('<span>').addClass('ftth-rota-extremo-lado').text(inicial ? 'Início' : 'Final').appendTo($info);
        $('<span>').addClass('ftth-rota-extremo-nome').text(nome || 'Ponta sem nome').appendTo($info);
        $linha.append($info);

        if (String(tipo || '').toUpperCase() === 'PONTA') {
            $('<span>').addClass('ftth-rota-extremo-estado').text('Livre').appendTo($linha);
        } else if (tipo) {
            $('<button type="button">').addClass('ftth-rota-extremo-soltar js-ftth-rota-soltar-ponta')
                .attr('data-lado', lado).attr('title', 'Soltar esta ponta do objeto conectado')
                .html('<i class="bi-unlink"></i> Soltar').appendTo($linha);
        } else {
            $('<span>').addClass('ftth-rota-extremo-estado').text('Indisponível').appendTo($linha);
        }
        $lista.append($linha);
    }

    function renderizarPainelRotaMover(linha, v) {
        if (!linha || !v || modo !== 'mover' || Number(v.id) !== Number(vaoAtivoMoverId)) {
            ocultarPainelRotaMover();
            return;
        }

        var $painel = $('#ftth-painel-rota');
        if (!$painel.hasClass('aberto')) abrirGaveta(false);
        $painel.addClass('aberto').attr('data-vao-id', Number(v.id));
        var extremos = (v.caixa_ini || v.nome_ini || 'Ponta') + ' → ' + (v.caixa_fim || v.nome_fim || 'Ponta');
        $('#ftth-rota-titulo').text(v.cabo_nome ? v.cabo_nome + ' · ' + extremos : extremos);
        atualizarComprimentoRotaMover(linha);

        var $extremos = $('#ftth-rota-extremos-lista').empty();
        renderizarExtremoRotaMover($extremos, v, 'ini');
        renderizarExtremoRotaMover($extremos, v, 'fim');

        var caminho = linha.getPath();
        var $lista = $('#ftth-rota-pontos').empty();
        var quantidade = Math.max(0, caminho.getLength() - 2);
        if (!quantidade) {
            $lista.hide();
            $('#ftth-rota-vazia').text('Sem pontos intermediários. Arraste uma alça clara no cabo para adicionar um ponto.')
                .show();
            return;
        }

        $('#ftth-rota-vazia').hide();
        $lista.show();
        for (var indice = 1; indice < caminho.getLength() - 1; indice++) {
            var p = caminho.getAt(indice);
            var numero = indice;
            var coordenadas = p.lat().toFixed(5) + ', ' + p.lng().toFixed(5);
            var $linha = $('<li>').addClass('ftth-rota-item');
            var $focar = $('<button type="button">').addClass('ftth-rota-focar js-ftth-rota-focar')
                .attr('data-indice', indice).attr('aria-label', 'Focar no ponto ' + numero);
            $('<span>').addClass('ftth-rota-numero').text(numero).appendTo($focar);
            $('<span>').addClass('ftth-rota-coordenadas').text(coordenadas).appendTo($focar);
            var $remover = $('<button type="button">').addClass('ftth-rota-remover js-ftth-rota-remover')
                .attr('data-indice', indice).attr('title', 'Remover somente este ponto da rota')
                .attr('aria-label', 'Remover o ponto ' + numero).html('<i class="bi-x-lg"></i>');
            $linha.append($focar, $remover).appendTo($lista);
        }
    }

    function ocultarPainelRotaMover() {
        $('#ftth-painel-rota').removeClass('aberto').removeAttr('data-vao-id');
        $('#ftth-rota-extremos-lista').empty();
        $('#ftth-rota-pontos').empty().hide();
        $('#ftth-rota-vazia').hide().text('');
        $('#ftth-rota-titulo').text('Selecione um cabo');
        $('#ftth-rota-comprimento').text('—');
        limparFocoVerticeRotaMover();
    }

    function fecharPainelRotaMover() {
        if (vinculoMeioMover && vinculoMeioMover.salvando) return;
        if (vinculoMeioMover) limparVinculoMeioMover();
        if (linhaAtivaMover) {
            linhaAtivaMover.setEditable(false);
            restaurarEstiloVaoMover(linhaAtivaMover);
        }
        linhaAtivaMover = null;
        vaoAtivoMoverId = null;
        alcasPontasMover.forEach(function (m) { m.setMap(null); });
        alcasPontasMover = [];
        limparSelecaoPontaMover();
        $('#mover-vinculo-abrir').hide();
        $('#mover-dica').text('Selecione um cabo para editar a rota.');
        ocultarPainelRotaMover();
    }

    function limparFocoVerticeRotaMover() {
        if (temporizadorFocoVerticeRotaMover) {
            clearTimeout(temporizadorFocoVerticeRotaMover);
            temporizadorFocoVerticeRotaMover = null;
        }
        if (marcadorVerticeRotaMover) {
            marcadorVerticeRotaMover.setMap(null);
            marcadorVerticeRotaMover = null;
        }
    }

    function focarVerticeRotaMover(indice) {
        var linha = linhaAtivaMover;
        var caminho = linha && linha.getPath();
        indice = Number(indice);
        if (modo !== 'mover' || !caminho || indice <= 0 || indice >= caminho.getLength() - 1
            || Math.floor(indice) !== indice) return;

        limparFocoVerticeRotaMover();
        var posicao = caminho.getAt(indice);
        mapa.panTo(posicao);
        marcadorVerticeRotaMover = new google.maps.Marker({
            position: posicao, map: mapa, clickable: false, zIndex: Z_CABO + 30,
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#E53935',
                   fillOpacity: 1, strokeColor: '#FFFFFF', strokeWeight: 2 }
        });
        temporizadorFocoVerticeRotaMover = setTimeout(function () {
            limparFocoVerticeRotaMover();
        }, 1800);
    }

    function restaurarCliqueNaAlcaIntermediaria(linha, v, evento) {
        var insercao = linha && linha.ftthUltimaInsercao;
        var idsCaixas = Object.keys(pendentes.caixas);
        var idsVaos = Object.keys(pendentes.vaos);
        var base = v && v.vertices;
        var atual = v && pendentes.vaos[v.id];
        if (!insercao || insercao.manual || Date.now() - insercao.hora > 1500 || idsCaixas.length
            || idsVaos.length !== 1 || Number(idsVaos[0]) !== Number(v.id)
            || !Array.isArray(base) || !Array.isArray(atual) || atual.length !== base.length + 1
            || !linha.ftthDesfazerInsercaoIntermediaria) return false;

        if (evento && evento.vertex !== undefined && evento.vertex !== null
            && Number(evento.vertex) !== insercao.indice) return false;
        var pontoNovo = atual[insercao.indice];
        if (!pontoNovo) return false;
        if (evento && evento.latLng
            && dist([evento.latLng.lat(), evento.latLng.lng()], pontoNovo) > 0.00005) return false;
        var j = 0;
        for (var i = 0; i < atual.length; i++) {
            if (i === insercao.indice) continue;
            var p = atual[i], q = base[j++];
            if (!q || Math.abs(Number(p[0]) - Number(q[0])) > 1e-7
                || Math.abs(Number(p[1]) - Number(q[1])) > 1e-7) return false;
        }
        return linha.ftthDesfazerInsercaoIntermediaria(insercao.indice);
    }

    /** Alças circulares explícitas: as pontas do cabo ficam selecionáveis sem arrastar a CTO. */
    function desenharAlcasPontasMover(v) {
        alcasPontasMover.forEach(function (m) { m.setMap(null); });
        alcasPontasMover = [];
        if (modo !== 'mover' || Number(vaoAtivoMoverId) !== Number(v.id)) return;
        var pts = pontosDoVao(v);
        if (pts.length < 2) return;
        [
            { lado: 'ini', ponto: pts[0], rotulo: 'inicial' },
            { lado: 'fim', ponto: pts[pts.length - 1], rotulo: 'final' }
        ].forEach(function (p) {
            var selecionada = pontaSelecionadaMover
                && Number(pontaSelecionadaMover.vao) === Number(v.id)
                && pontaSelecionadaMover.lado === p.lado;
            var caixaId = Number(p.lado === 'ini' ? v.caixa_ini_id : v.caixa_fim_id);
            var caixaPonta = (ultimoDesenho && ultimoDesenho.caixas || []).filter(function (c) {
                return Number(c.id) === caixaId;
            })[0];
            var livre = caixaPonta && caixaPonta.tipo === 'PONTA';
            var m = new google.maps.Marker({
                position: { lat: p.ponto[0], lng: p.ponto[1] }, map: mapa,
                clickable: true, draggable: !!livre, zIndex: Z_CAIXA_ARRASTANDO + 100,
                title: 'Selecionar ponta ' + p.rotulo + ' de ' + (v.cabo_nome || 'cabo'),
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: selecionada ? 9 : 7,
                    fillColor: selecionada ? '#FFC107' : '#FFFFFF', fillOpacity: 1,
                    strokeColor: selecionada ? '#1565C0' : (v.cor_rota || '#00E676'),
                    strokeWeight: selecionada ? 4 : 3 }
            });
            m.addListener('click', function () { selecionarPontaMover(v, p.lado); });
            if (livre) {
                m.addListener('dragstart', function () {
                    if (pontaSelecionadaMover) limparSelecaoPontaMover();
                });
                m.addListener('drag', function (ev) {
                    pendentes.caixas[caixaId] = { lat: ev.latLng.lat(), lng: ev.latLng.lng(),
                        nome: caixaPonta.nome, tipo: 'PONTA' };
                    arrastarPontasNaTela(caixaId);
                    atualizarContaMover();
                });
                m.addListener('dragend', function () {
                    atualizarContaMover();
                    desenharAlcasPontasMover(v);
                });
            }
            alcasPontasMover.push(m);
        });
    }

    function selecionarPontaMover(v, lado, aoCarregar) {
        if (contarPendentes() > 0) {
            FTTH.toast('info', 'Conclua ou cancele as alterações de posição e traçado antes de vincular uma ponta.');
            if (typeof aoCarregar === 'function') aoCarregar(null);
            return;
        }
        limparVinculoMeioMover();
        pontaSelecionadaMover = { vao: Number(v.id), lado: lado, previa: null };
        desenharAlcasPontasMover(v);
        $('#mover-dica').text('Carregando os dados da ponta selecionada…');
        $('#mover-ponta-status').text('Carregando ponta selecionada…').show();
        FTTH.chamar({
            url: 'mapa.php?ajax=vao_ponta_previa&vao=' + Number(v.id) + '&lado=' + encodeURIComponent(lado),
            onOk: function (d) {
                if (!pontaSelecionadaMover || Number(pontaSelecionadaMover.vao) !== Number(v.id)
                    || pontaSelecionadaMover.lado !== lado) return;
                pontaSelecionadaMover.previa = d;
                mostrarPontaSelecionadaMover(d);
                desenharAlcasPontasMover(v);
                if (typeof aoCarregar === 'function') aoCarregar(d);
            },
            onErro: function (m) {
                $('#mover-dica').text(m);
                limparSelecaoPontaMover();
                desenharAlcasPontasMover(v);
                if (typeof aoCarregar === 'function') aoCarregar(null);
            }
        });
    }

    function mostrarPontaSelecionadaMover(d) {
        var lado = d.lado === 'ini' ? 'inicial' : 'final';
        var texto = d.caixa_tipo === 'PONTA'
            ? 'Ponta livre ' + lado + ' de “' + d.cabo_nome + '”. Clique num objeto para conectar.'
            : 'Ponta ' + lado + ' de “' + d.cabo_nome + '” em '
                + d.caixa_nome + '. Clique no objeto de destino ou escolha Soltar ponta.';
        $('#mover-dica').text(texto);
        $('#mover-ponta-status').text('Selecionada: ' + lado + ' · ' + d.cabo_nome + ' · ' + d.caixa_nome).show();
        $('#mover-ponta-soltar').toggle(d.caixa_tipo !== 'PONTA');
    }

    function limparSelecaoPontaMover() {
        pontaSelecionadaMover = null;
        $('#mover-ponta-soltar').hide().prop('disabled', false);
        $('#mover-ponta-status').hide().text('');
    }

    function alterarPontaMover(caixaAlvo, aoFinalizar) {
        function finalizarAcao() {
            if (typeof aoFinalizar === 'function') aoFinalizar();
        }
        var sel = pontaSelecionadaMover;
        var previa = sel && sel.previa;
        if (!previa) {
            FTTH.toast('info', 'Selecione uma das pontas circulares da rota primeiro.');
            finalizarAcao();
            return;
        }
        if (contarPendentes() > 0) {
            FTTH.toast('info', 'Conclua ou cancele as alterações de posição e traçado antes de vincular uma ponta.');
            finalizarAcao();
            return;
        }
        var destino = caixaAlvo || null;
        var verbo = destino ? 'conectar' : 'soltar';
        var rotuloDestino = destino ? destino.nome : 'uma ponta livre no mesmo local';
        var texto = 'Deseja ' + verbo + ' a ponta ' + (previa.lado === 'ini' ? 'inicial' : 'final')
            + ' do cabo “' + previa.cabo_nome + '” em ' + rotuloDestino + '?';
        if (Number(previa.ligacoes) > 0) {
            texto += '\n\nSerão removidas ' + Number(previa.ligacoes) + ' ligação(ões) de fibra, afetando '
                + Number(previa.fibras) + ' fibra(s) cadastrada(s) em ' + previa.caixa_nome
                + '. Nenhuma fusão será criada no destino.';
        }
        if (!confirm(texto)) {
            finalizarAcao();
            return;
        }

        var cfg = window.FTTH_MAPA || {};
        $('#mover-ponta-soltar').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=vao_ponta_alterar', method: 'POST',
            data: { csrf: cfg.csrf, vao: sel.vao, lado: sel.lado,
                    caixa: destino ? Number(destino.id) : '', versao: Number(previa.versao) },
            onOk: function (d) {
                limparSelecaoPontaMover();
                carregar();
                FTTH.toast('ok', (destino ? 'Ponta conectada a ' + destino.nome : 'Ponta solta')
                    + (d.ligacoes_removidas ? '; ' + d.ligacoes_removidas + ' ligação(ões) de fibra removida(s).' : '.')
                    + ' Comprimento recalculado.');
                finalizarAcao();
            },
            onErro: function (m) {
                FTTH.toast('erro', m);
                $('#mover-ponta-soltar').prop('disabled', false);
                finalizarAcao();
            }
        });
    }

    function soltarPontaPainelMover(lado) {
        var rota = (ultimoDesenho && ultimoDesenho.vaos || []).filter(function (v) {
            return Number(v.id) === Number(vaoAtivoMoverId);
        })[0];
        if (!rota || modo !== 'mover' || ['ini', 'fim'].indexOf(lado) === -1) {
            FTTH.toast('info', 'Selecione um cabo antes de soltar uma ponta.');
            return;
        }

        var tipo = lado === 'ini' ? rota.caixa_ini_tipo : rota.caixa_fim_tipo;
        if (String(tipo || '').toUpperCase() === 'PONTA') {
            FTTH.toast('info', 'Essa ponta já está livre.');
            return;
        }
        if (!tipo) {
            FTTH.toast('erro', 'Não foi possível identificar o objeto conectado. Atualize o mapa e tente novamente.');
            return;
        }

        var $botoes = $('#ftth-rota-extremos-lista .js-ftth-rota-soltar-ponta').prop('disabled', true);
        selecionarPontaMover(rota, lado, function (d) {
            if (!d) {
                $botoes.prop('disabled', false);
                return;
            }
            if (String(d.caixa_tipo || '').toUpperCase() === 'PONTA') {
                limparSelecaoPontaMover();
                desenharAlcasPontasMover(rota);
                carregar();
                FTTH.toast('info', 'Essa ponta já estava livre; o mapa foi atualizado.');
                $botoes.prop('disabled', false);
                return;
            }
            alterarPontaMover(null, function () { $botoes.prop('disabled', false); });
        });
    }

    function vincularPontaMover(c) {
        if (!c || !c.id) return;
        if (['PONTA', 'RESERVA', 'POSTE'].indexOf(c.tipo) !== -1) {
            FTTH.toast('info', 'Escolha uma CTO, CEO, POP ou outro ponto compatível para conectar o cabo.');
            return;
        }
        alterarPontaMover({ id: Number(c.id), nome: String(c.nome || 'objeto') });
    }

    function iniciarVinculoMeioMover(v) {
        if (contarPendentes() > 0) {
            FTTH.toast('info', 'Conclua ou cancele as alterações de posição e traçado antes de vincular uma caixa no meio do cabo.');
            return;
        }
        limparSelecaoPontaMover();
        desenharAlcasPontasMover(v);
        abrirModalEmenda(
            'Você selecionou o trecho do cabo <strong>“' + esc(v.cabo_nome || 'sem nome')
                + '”</strong>. Quer escolher uma CTO, CEO ou outro ponto existente para conectá-lo aqui?',
            'Escolher item', 'Cancelar',
            function () {
                fecharModalEmenda();
                vinculoMeioMover = {
                    vao: Number(v.id),
                    caboNome: String(v.cabo_nome || 'sem nome'),
                    salvando: false
                };
                $('#mover-vinculo-abrir').hide();
                $('#mover-vinculo-status').text('Vínculo no meio de “' + vinculoMeioMover.caboNome
                    + '”: clique numa CTO, CEO ou ponto compatível.').show();
                $('#mover-vinculo-cancelar').show().prop('disabled', false);
                $('#mover-dica').text('Escolha o ponto existente que será conectado ao cabo.');
            },
            function () { fecharModalEmenda(); },
            'meio'
        );
    }

    function vincularMeioAoObjetoMover(c) {
        var sel = vinculoMeioMover;
        if (!sel || sel.salvando || !c || !c.id) return;
        if (['PONTA', 'RESERVA', 'POSTE'].indexOf(c.tipo) !== -1) {
            FTTH.toast('info', 'Escolha uma CTO, CEO, POP ou outro ponto compatível para conectar ao cabo.');
            return;
        }
        if (contarPendentes() > 0) {
            FTTH.toast('info', 'Conclua ou cancele as alterações de posição e traçado antes de vincular uma caixa no meio do cabo.');
            return;
        }
        var impacto = 'Conectar “' + String(c.nome || 'ponto') + '” ao cabo “' + sel.caboNome + '”?'
            + '\n\nO ponto será movido até a rota. Outros cabos ligados a ele acompanharão o movimento. '
            + 'O cabo será dividido em dois trechos, com as fibras passando pelo ponto.';
        if (!confirm(impacto)) return;

        var cfg = window.FTTH_MAPA || {};
        sel.salvando = true;
        $('#mover-vinculo-cancelar').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=quebrar_vao', method: 'POST',
            data: { csrf: cfg.csrf, vao: sel.vao, caixa: Number(c.id) },
            onOk: function (d) {
                limparVinculoMeioMover();
                carregar();
                FTTH.toast('ok', 'Cabo dividido em dois trechos: '
                    + Math.round(d.metros_a) + ' m e ' + Math.round(d.metros_b) + ' m, com '
                    + d.fibras_passando + ' fibra(s) passando por ' + String(c.nome || 'o ponto') + '.');
            },
            onErro: function (m) {
                FTTH.toast('erro', m);
                if (vinculoMeioMover === sel) {
                    sel.salvando = false;
                    $('#mover-vinculo-cancelar').prop('disabled', false);
                }
            }
        });
    }

    function limparVinculoMeioMover() {
        vinculoMeioMover = null;
        $('#mover-vinculo-status').hide().text('');
        $('#mover-vinculo-cancelar').hide().prop('disabled', false);
        var rota = (ultimoDesenho && ultimoDesenho.vaos || []).filter(function (v) {
            return Number(v.id) === Number(vaoAtivoMoverId);
        })[0];
        $('#mover-vinculo-abrir').toggle(modo === 'mover' && !!rota);
        if (modo === 'mover' && rota) dicaVaoMover(rota);
    }

    function contarPendentes() {
        return Object.keys(pendentes.caixas).length + Object.keys(pendentes.vaos).length;
    }

    function atualizarContaMover() {
        var n = contarPendentes();
        $('#mover-conta').text(n ? n + ' alteração(ões)' : 'nada alterado');
        $('#mover-concluir').prop('disabled', n === 0);
    }

    function sairDoModoMover() {
        pendentes = { caixas: {}, vaos: {} };
        if (linhaAtivaMover) {
            linhaAtivaMover.setEditable(false);
            restaurarEstiloVaoMover(linhaAtivaMover);
        }
        ocultarPainelRotaMover();
        vaoAtivoMoverId = null;
        linhaAtivaMover = null;
        limparSelecaoPontaMover();
        limparVinculoMeioMover();
        $('#mover-card').hide();
        ajustarToasts();
        carregar();                     // volta o que está no banco
    }

    /**
     * Geometria atual do vão: a pendente, se o usuário mexeu no traçado, senão a do banco.
     *
     * As PONTAS são sempre derivadas da posição da caixa, nunca guardadas — o mesmo que o
     * servidor faz. Assim arrastar uma caixa com três cabos não vira "4 alterações": a
     * alteração é uma só, a da caixa, e os cabos apenas acompanham.
     */
    /**
     * Onde a caixa está agora: a posição arrastada, se houver, senão a do último desenho.
     * É a única fonte de verdade para as pontas de cabo — nunca o traçado guardado, que é
     * justamente o que pode estar torto depois de um arrasto acidental na alça da ponta.
     */
    function posicaoDaCaixa(caixaId) {
        // Ponta livre ancorada (pendente): a ponta do cabo já é desenhada no ponto.
        var pend = pendentes.caixas[caixaId];
        if (pend) return [pend.lat, pend.lng];
        var achada = null;
        ((ultimoDesenho && ultimoDesenho.caixas) || []).forEach(function (c) {
            if (Number(c.id) === Number(caixaId)) {
                achada = [parseFloat(c.lat), parseFloat(c.lng)];
            }
        });
        return achada;
    }

    function pontosDoVao(v) {
        var pts = (pendentes.vaos[v.id] || (v.vertices || []).map(function (p) {
            return [parseFloat(p[0]), parseFloat(p[1])];
        })).slice();

        var ini = posicaoDaCaixa(v.caixa_ini_id);
        var fim = posicaoDaCaixa(v.caixa_fim_id);
        if (ini) pts[0] = ini;
        if (fim && pts.length > 1) pts[pts.length - 1] = fim;
        return pts;
    }

    /**
     * Liga a edição nativa do Google na linha: ele desenha as alças dos vértices e, entre
     * elas, as alças intermediárias que criam um vértice novo ao serem arrastadas — é o
     * "criar vértice no cabo" do UpperX, de graça e bem mais leve que marcadores próprios.
     */
    function tornarEditavel(linha, v) {
        if (linha.ftthEventosEdicao) {
            linha.setEditable(true);
            return;
        }

        var caminho = linha.getPath();
        var ajustando = false;   // setAt dentro do próprio listener dispara ele de novo
        var inserindoVerticeManual = false;
        linha.ftthUltimaInsercao = null;

        /**
         * Grava a pendência. Só LÊ a polilinha: as pontas são trocadas no array que vai para
         * `pendentes`, nunca no path.
         *
         * Mexer no path de dentro de um listener do próprio path deixa o editor do Google em
         * estado inconsistente — dava "Cannot read properties of undefined" no meio de um
         * insertAt e fazia aparecer vértice fantasma no cabo.
         */
        var gravar = function () {
            var pts = [];
            caminho.forEach(function (p) { pts.push([p.lat(), p.lng()]); });
            var ini = posicaoDaCaixa(v.caixa_ini_id);
            var fim = posicaoDaCaixa(v.caixa_fim_id);
            if (ini) pts[0] = ini;
            if (fim && pts.length > 1) pts[pts.length - 1] = fim;
            pendentes.vaos[v.id] = pts;
            atualizarContaMover();
            if (linhaAtivaMover === linha) {
                limparFocoVerticeRotaMover();
                renderizarPainelRotaMover(linha, v);
            }
        };

        /**
         * Devolve as pontas para cima das caixas — depois que o Google terminar o que estava
         * fazendo. O setTimeout(0) é o que separa a nossa correção do evento dele.
         */
        var colarPontasDepois = function () {
            setTimeout(function () {
                var ultimo = caminho.getLength() - 1;
                if (ultimo < 1) return;
                var ini = posicaoDaCaixa(v.caixa_ini_id);
                var fim = posicaoDaCaixa(v.caixa_fim_id);
                ajustando = true;
                if (ini) caminho.setAt(0, new google.maps.LatLng(ini[0], ini[1]));
                if (fim) caminho.setAt(ultimo, new google.maps.LatLng(fim[0], fim[1]));
                ajustando = false;
                gravar();
            }, 0);
        };

        // A ponta pertence à caixa: arrastá-la descolaria o cabo. O Google não deixa travar um
        // vértice só, então ela volta sozinha para cima da caixa.
        caminho.addListener('set_at', function (i) {
            if (ajustando || linha.ftthColando) return;
            linha.ftthUltimaInsercao = null;
            var ultimo = caminho.getLength() - 1;
            if (i === 0 || i === ultimo) {
                colarPontasDepois();
                FTTH.toast('info', 'A ponta do cabo mora na caixa — para movê-la, arraste a caixa.');
                return;
            }
            gravar();
        });
        // Criar e remover vértice não avisam nada: quem arrasta a alça vê o ponto nascer, e
        // um toast a cada gesto atrapalha mais do que explica. O que a alça clara faz está
        // dito na dica do card, que fica à vista o tempo todo.
        caminho.addListener('insert_at', function (indice) {
            if (ajustando) return;
            linha.ftthUltimaInsercao = {
                indice: Number(indice), hora: Date.now(), manual: inserindoVerticeManual
            };
            gravar();
        });
        caminho.addListener('remove_at', function () {
            if (ajustando) return;
            linha.ftthUltimaInsercao = null;
            gravar();
        });
        // Se clicar na alça intermediária nativa inserir um vértice antes do click da rota,
        // desfazemos apenas essa inserção provisória. Arrastar a alça continua gerando
        // a pendência de geometria como antes.
        linha.ftthDesfazerInsercaoIntermediaria = function (indice) {
            if (indice <= 0 || indice >= caminho.getLength() - 1) return false;
            ajustando = true;
            caminho.removeAt(indice);
            ajustando = false;
            linha.ftthUltimaInsercao = null;
            delete pendentes.vaos[v.id];
            atualizarContaMover();
            limparFocoVerticeRotaMover();
            renderizarPainelRotaMover(linha, v);
            return true;
        };

        // Botão direito: no vértice remove, na linha insere no ponto clicado.
        linha.addListener('rightclick', function (e) {
            if (modo !== 'mover' || linhaAtivaMover !== linha) return;
            if (e.vertex !== undefined && e.vertex !== null) {
                var ultimo = caminho.getLength() - 1;
                if (e.vertex === 0 || e.vertex === ultimo) {
                    FTTH.toast('erro', 'A ponta do cabo é da caixa e não pode sair.');
                    return;
                }
                if (caminho.getLength() <= 2) {
                    FTTH.toast('erro', 'O cabo precisa de ao menos dois pontos.');
                    return;
                }
                caminho.removeAt(e.vertex);
                return;
            }
            inserindoVerticeManual = true;
            try {
                inserirVertice(caminho, e.latLng);
            } finally {
                inserindoVerticeManual = false;
            }
        });
        linha.ftthEventosEdicao = true;
        linha.setEditable(true);
    }

    /** Insere um vértice no trecho onde o clique caiu. */
    function inserirVertice(caminho, latLng) {
        var pts = [];
        caminho.forEach(function (p) { pts.push([p.lat(), p.lng()]); });

        // O trecho que menos cresce ao receber o ponto novo é aquele em que o clique caiu.
        var alvo = [latLng.lat(), latLng.lng()];
        var melhor = 1, menor = Infinity;
        for (var i = 1; i < pts.length; i++) {
            var extra = dist(pts[i - 1], alvo) + dist(alvo, pts[i]) - dist(pts[i - 1], pts[i]);
            if (extra < menor) { menor = extra; melhor = i; }
        }
        caminho.insertAt(melhor, latLng);   // o insert_at grava a pendência
    }

    /** Distância plana, só para comparar trechos — não é a do cálculo óptico. */
    function dist(a, b) {
        var dx = a[0] - b[0], dy = a[1] - b[1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** Enquanto a caixa é arrastada, as pontas dos cabos dela acompanham na tela. */
    function arrastarPontasNaTela(caixaId) {
        if (!ultimoDesenho) return;
        var posicao = posicaoDaCaixa(caixaId);
        if (posicao) {
            marcadores.forEach(function (m) {
                if (Number(m.ftthCaixaId) === Number(caixaId)) {
                    m.setPosition({ lat: posicao[0], lng: posicao[1] });
                }
            });
        }
        (ultimoDesenho.vaos || []).forEach(function (v) {
            if (Number(v.caixa_ini_id) !== Number(caixaId)
                && Number(v.caixa_fim_id) !== Number(caixaId)) {
                return;
            }
            var pts = pontosDoVao(v).map(function (p) { return { lat: p[0], lng: p[1] }; });
            linhas.forEach(function (l) {
                if (l.ftthVaoId !== v.id) return;
                // Preserve o MVCArray da linha também quando ela não está selecionada. Trocar
                // o caminho com setPath deixa event listeners já instalados presos ao array
                // antigo; ao selecionar a rota depois, as edições deixam de gravar pendências.
                var caminho = l.getPath();
                var ultimo = caminho.getLength() - 1;
                if (ultimo < 1 || pts.length < 2) return;
                // A ponta pertence à caixa. A alteração geométrica é só visual e não deve
                // disparar os listeners do caminho mesmo se ele já foi editado nesta sessão.
                l.ftthColando = true;    // não é o usuário puxando a ponta: sem aviso
                caminho.setAt(0, new google.maps.LatLng(pts[0].lat, pts[0].lng));
                caminho.setAt(ultimo, new google.maps.LatLng(pts[pts.length - 1].lat,
                                                             pts[pts.length - 1].lng));
                l.ftthColando = false;
                if (Number(vaoAtivoMoverId) === Number(v.id) && alcasPontasMover.length === 2) {
                    alcasPontasMover[0].setPosition(new google.maps.LatLng(pts[0].lat, pts[0].lng));
                    alcasPontasMover[1].setPosition(new google.maps.LatLng(
                        pts[pts.length - 1].lat, pts[pts.length - 1].lng));
                }
                if (l === linhaAtivaMover) atualizarComprimentoRotaMover(l);
            });
        });
    }

    function concluirMover() {
        var cfg = window.FTTH_MAPA || {};
        var caixas = Object.keys(pendentes.caixas).map(function (id) {
            return { id: parseInt(id, 10), lat: pendentes.caixas[id].lat,
                     lng: pendentes.caixas[id].lng };
        });
        var vaos = Object.keys(pendentes.vaos).map(function (id) {
            return { id: parseInt(id, 10), vertices: pendentes.vaos[id] };
        });
        if (!caixas.length && !vaos.length) return;

        var $b = $('#mover-concluir').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=mover',
            method: 'POST',
            data: { csrf: cfg.csrf, caixas: JSON.stringify(caixas), vaos: JSON.stringify(vaos) },
            onOk: function (d) {
                pendentes = { caixas: {}, vaos: {} };
                // Gravou: a edição acabou. O card se fecha e o mapa volta ao modo Navegar,
                // que é onde o técnico confere o resultado do que acabou de fazer.
                definirModo('navegar');
                FTTH.toast('ok', 'Mapa atualizado: ' + d.caixas + ' caixa(s) e '
                    + d.vaos + ' traçado(s). Os comprimentos foram recalculados.');
            },
            // Nada foi gravado — o lote é uma transação só —, então as pendências ficam
            // na tela para o usuário corrigir em vez de perder o trabalho.
            onErro: function (m) { FTTH.toast('erro', m); }
        }).always(function () { $b.prop('disabled', contarPendentes() === 0); });
    }

    /**
     * O que um clique no mapa faz, por modo. Vive numa função só porque o clique pode chegar
     * de dois lugares: do mapa e de cima de um cabo, que é um objeto por cima do mapa.
     */
    function modoDeDesenho(m) {
        return m === 'caixa' || m === 'cabo' || m === 'selecionar' || m === 'medir';
    }

    function cursorDoCabo() {
        return modoDeDesenho(modo) ? 'crosshair' : 'pointer';
    }

    function cliqueNoMapa(e) {
        if (modo === 'medir') {
            adicionarPontoMedicao(e.latLng);
            return;
        }
        if (callbackPontoViabilidade && callbackPontoViabilidade(e.latLng)) return;
        if (modo === 'caixa') {
            marcarPonto(e.latLng);
            return;
        }
        if (modo === 'selecionar') {
            if (!selecao) verticeDaArea(e.latLng);
            return;
        }
        if (modo === 'cabo') {
            pontoTracado({ tipo: 'VERTICE', lat: e.latLng.lat(), lng: e.latLng.lng() });
            return;
        }
        $('#painel').hide();
    }

    /** Marca até dois pontos e exibe a distância geográfica aproximada entre eles. */
    function adicionarPontoMedicao(latLng) {
        if (!latLng || modo !== 'medir') return;
        if (pontosMedicao.length >= 2) {
            FTTH.toast('info', 'Use Limpar para iniciar outra medição.');
            return;
        }
        pontosMedicao.push(latLng);
        var rotulo = pontosMedicao.length === 1 ? 'A' : 'B';
        var cor = pontosMedicao.length === 1 ? '#00A86B' : '#E53935';
        marcadoresMedicao.push(new google.maps.Marker({
            position: latLng, map: mapa, title: 'Ponto ' + rotulo + ' da medição',
            clickable: false, zIndex: Z_CAIXA + 200,
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: cor,
                    fillOpacity: 1, strokeColor: '#FFFFFF', strokeWeight: 2 },
            label: { text: rotulo, color: '#FFFFFF', fontSize: '10px', fontWeight: '700' }
        }));
        if (pontosMedicao.length === 1) {
            $('#medir-status').text('Ponto A marcado. Clique para escolher o destino.');
            $('#medir-distancia').text('');
            return;
        }
        linhaMedicao = new google.maps.Polyline({
            map: mapa, path: pontosMedicao, geodesic: true, clickable: false,
            strokeColor: '#00AEEF', strokeOpacity: 1, strokeWeight: 4, zIndex: Z_CAIXA + 199
        });
        var metros = distanciaEntrePontos(pontosMedicao[0], pontosMedicao[1]);
        var texto = metros < 1000
            ? Math.round(metros).toLocaleString('pt-BR') + ' m'
            : (metros / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';
        $('#medir-status').text('Distância entre os pontos A e B');
        $('#medir-distancia').text(texto);
    }

    function distanciaEntrePontos(a, b) {
        var raioTerra = 6371008.8, rad = Math.PI / 180;
        var lat1 = a.lat() * rad, lat2 = b.lat() * rad;
        var deltaLat = (b.lat() - a.lat()) * rad, deltaLng = (b.lng() - a.lng()) * rad;
        var senoLat = Math.sin(deltaLat / 2), senoLng = Math.sin(deltaLng / 2);
        var h = senoLat * senoLat + Math.cos(lat1) * Math.cos(lat2) * senoLng * senoLng;
        h = Math.min(1, Math.max(0, h));
        return 2 * raioTerra * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function limparMedicao() {
        marcadoresMedicao.forEach(function (m) { m.setMap(null); });
        marcadoresMedicao = [];
        if (linhaMedicao) linhaMedicao.setMap(null);
        linhaMedicao = null;
        pontosMedicao = [];
        $('#medir-status').text('Clique no mapa para marcar o ponto inicial.');
        $('#medir-distancia').text('');
    }

    function limparPin() {
        if (pinTemporario) { pinTemporario.setMap(null); pinTemporario = null; }
        pontoNovo = null;
    }

    /** Marca o ponto escolhido e abre o modal já sabendo onde a caixa vai nascer. */
    function marcarPonto(latLng) {
        limparPin();
        pontoNovo = latLng;
        if (!travas.pop) selecionarTipo('DC');   // o pino já nasce com a cara do que vai ser
        pinTemporario = new google.maps.Marker({
            position: latLng, map: mapa, zIndex: 999,
            icon: icone(tipoSelecionado(), corSelecionada(), true)
        });
        $('#nc-ponto').text('Ponto: ' + latLng.lat().toFixed(6) + ', ' + latLng.lng().toFixed(6));
        // Clicou em cima de um cabo? A pergunta vem agora, antes do cadastro: a decisão é
        // sobre o ponto, e escolher o tipo da caixa depois é o passo natural.
        // Reserva e poste não emendam: se o tipo já está escolhido, a pergunta nem aparece.
        if (tipoSelecionado() === 'RESERVA' || tipoSelecionado() === 'POSTE') {
            abrirModalCaixa();
            return;
        }
        perguntarEmendaNoClique(latLng, abrirModalCaixa);
    }

    function tipoSelecionado() { return $('.ftth-tipo.ativo').data('tipo') || 'CTO'; }

    /**
     * A cor da caixa pode não estar na paleta (as importadas do KMZ têm a cor do arquivo).
     * Nesse caso a cor original é preservada, em vez de ser trocada em silêncio ao salvar.
     */
    var corEscolhida = null;
    function corSelecionada() {
        var ativa = $('.ftth-cor.ativo').data('cor');
        return ativa || corEscolhida || '#43A047';
    }

    function sugerirNome(base) {
        FTTH.chamar({
            url: 'mapa.php?ajax=sugerir_nome&regiao=' + regiao + '&tipo=' + tipoSelecionado()
                 + '&base=' + encodeURIComponent(base || ''),
            onOk: function (d) { if (d.nome) $('#nc-nome').val(d.nome); }
        });
    }

    /** Nome do tipo para os textos da tela: "Editar CTO", "Reserva criada". */
    var ROTULO_TIPO = { CTO: 'CTO', CEO: 'CEO', DC: 'DC / POP', PREDIO: 'prédio',
                        PROBLEMA: 'problema', RESERVA: 'reserva', PONTA: 'ponta livre', POSTE: 'poste' };

    var TIPOS_EM_SEQUENCIA = { CTO: true, CEO: true, RESERVA: true, POSTE: true };

    /** Os metros só existem para a Reserva; o resto do modal é igual para todo tipo. */
    function camposDoTipo() {
        $('#nc-reserva-area').toggle(tipoSelecionado() === 'RESERVA');
        // Numerar em sequência só vale no cadastro e para o que se lança em série na rua.
        $('#nc-sequencia-area').toggle(!editando && TIPOS_EM_SEQUENCIA[tipoSelecionado()] === true);
    }

    function abrirModalCaixa() {
        editando = null;
        $('#modal-titulo').text('Novo ponto');
        $('#nc-criar').text('Criar ponto');
        $('#nc-reserva').val('');
        $('#nc-saida').empty();
        aplicarTravaTipos();
        camposDoTipo();
        $('#modal-caixa').show();
        if (presetPonto && presetPonto.nome) {
            $('#nc-nome').val(presetPonto.nome);
        } else {
            sugerirNome('');
        }
        setTimeout(function () { $('#nc-nome').trigger('focus').trigger('select'); }, 50);
    }

    /** Mesmo modal do cadastro, agora preenchido com a caixa que existe. */
    function abrirModalEdicao(c) {
        editando = { id: parseInt(c.id, 10), versao: parseInt(c.versao, 10) };
        limparPin();

        $('#modal-titulo').text('Editar ' + (ROTULO_TIPO[c.tipo] || 'ponto'));
        $('#nc-criar').text('Salvar');
        $('#nc-saida').empty();

        $('#nc-nome').val(c.nome);
        $('#nc-reserva').val(c.reserva_m ? String(parseFloat(c.reserva_m)) : '');
        $('#nc-ponto').text('Ponto: ' + parseFloat(c.lat).toFixed(6) + ', ' + parseFloat(c.lng).toFixed(6)
            + ' — para mudar de lugar, use o modo Mover.');

        aplicarTravaTipos();                      // na edição, destrava tudo
        $('.ftth-tipo').removeClass('ativo');
        var $t = $('.ftth-tipo[data-tipo="' + c.tipo + '"]');
        ($t.length ? $t : $('.ftth-tipo[data-tipo="CTO"]')).addClass('ativo');
        camposDoTipo();

        corEscolhida = c.cor;
        $('.ftth-cor').removeClass('ativo');
        var $c = $('.ftth-cor[data-cor="' + String(c.cor).toUpperCase() + '"]');
        if ($c.length) {
            $c.addClass('ativo');
        } else {
            // Cor fora da paleta (veio do KMZ): mostra como está, sem forçar troca.
            $('#nc-saida').html('<p class="ftth-sub">Cor atual <span class="mono">' + esc(c.cor)
                + '</span> não está na paleta; escolha uma só se quiser trocar.</p>');
        }

        $('#modal-caixa').show();
        setTimeout(function () { $('#nc-nome').trigger('focus').trigger('select'); }, 50);
    }

    /** Um só botão para os dois casos: criar (com ponto marcado) e salvar edição. */
    function salvarCaixa() {
        var cfg = window.FTTH_MAPA || {};
        var nome = $.trim($('#nc-nome').val());
        if (!nome) {
            $('#nc-saida').html('<div class="ftth-aviso ftth-aviso--erro">Informe o nome do ponto.</div>');
            return;
        }

        if (editando) {
            $('#nc-criar').prop('disabled', true);
            FTTH.chamar({
                url: 'mapa.php?ajax=alterar_caixa',
                method: 'POST',
                data: {
                    csrf: cfg.csrf, id: editando.id, versao: editando.versao,
                    nome: nome, tipo: tipoSelecionado(), cor: corSelecionada(),
                    reserva_m: $('#nc-reserva').val()
                },
                onOk: function (d) {
                    var id = editando.id;
                    editando = null;
                    $('#modal-caixa').hide();
                    carregar();
                    abrirFicha(id);
                },
                onErro: function (m) {
                    $('#nc-saida').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
                }
            }).always(function () { $('#nc-criar').prop('disabled', false); });
            return;
        }

        if (!pontoNovo) {
            $('#nc-saida').html('<div class="ftth-aviso ftth-aviso--erro">Marque o ponto no mapa.</div>');
            return;
        }
        var sequencia = $('#nc-sequencia-area').is(':visible') && $('#nc-sequencia').is(':checked');

        $('#nc-criar').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=nova_caixa',
            method: 'POST',
            data: {
                csrf: cfg.csrf, regiao: regiao,
                nome: nome, tipo: tipoSelecionado(), cor: corSelecionada(),
                reserva_m: $('#nc-reserva').val(),
                lat: pontoNovo.lat(), lng: pontoNovo.lng()
            },
            onOk: function (d) {
                limparPin();
                $('#modal-caixa').hide();
                carregar();

                if (d.ponta_absorvida) {
                    FTTH.toast('ok', nome + ' assumiu a ponta livre: o cabo agora termina nele.');
                }
                var seguir = function () {
                    if (sequencia) {
                        // Continua no modo Caixa: o próximo clique já marca a caixa seguinte.
                        FTTH.toast('ok', nome + ' criado. Clique no mapa para o próximo.');
                    } else {
                        definirModo('navegar');
                        abrirFicha(d.id);
                    }
                };

                // A emenda já foi decidida no clique; agora que a caixa existe, aplicamos.
                // Reserva nunca emenda: ela fica em cima do cabo, que continua inteiro.
                if (d.tipo === 'RESERVA' || d.tipo === 'POSTE') emendaDesejada = null;
                if (emendaDesejada) {
                    var vao = emendaDesejada.vao;
                    emendaDesejada = null;
                    aplicarEmenda(vao, d.id, seguir);
                } else {
                    seguir();
                }
            },
            onErro: function (m) {
                $('#nc-saida').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
            }
        }).always(function () { $('#nc-criar').prop('disabled', false); });
    }

    /* ------------------------------------------------------------------ vista salva */

    /**
     * Onde o mapa estava (região, centro e zoom), guardado na aba do navegador. Quem abre o
     * diagrama de uma caixa e volta quer continuar no mesmo ponto, não no centro da região.
     * sessionStorage e não localStorage: aba nova começa do padrão da região.
     */
    var CHAVE_VISTA = 'ftth_mapa_vista';

    function lerVista() {
        try {
            var v = JSON.parse(sessionStorage.getItem(CHAVE_VISTA) || 'null');
            return (v && isFinite(v.lat) && isFinite(v.lng) && isFinite(v.zoom)) ? v : null;
        } catch (e) {
            return null;
        }
    }

    function guardarVista() {
        var c = mapa && mapa.getCenter();
        if (!c) return;
        try {
            sessionStorage.setItem(CHAVE_VISTA, JSON.stringify({
                regiao: regiao, lat: c.lat(), lng: c.lng(), zoom: mapa.getZoom()
            }));
        } catch (e) { /* navegador sem storage: só não lembra */ }
    }

    /* ------------------------------------------------------------------ regiões e painel */

    /**
     * Onde o mapa vai ao entrar numa região, em ordem de prioridade (a 1ª, a vista guardada
     * na aba, é resolvida na abertura da página):
     *   2. a moldura dos pontos — um centro gravado errado deixa de importar no 1º ponto;
     *   3. o centro e o zoom gravados na região, que só valem para região vazia;
     *   4. o centro do Brasil, quando nada acima existe.
     */
    var CENTRO_BRASIL = { lat: -14.235, lng: -51.9253 };
    var ZOOM_BRASIL = 4;
    var ZOOM_MAX_ENQUADRAR = 18;   // rede de um ponto só não pode abrir no zoom 21
    var regioes = [];

    function acharRegiao(id) {
        var achada = null;
        regioes.forEach(function (r) { if (Number(r.id) === Number(id)) achada = r; });
        return achada;
    }

    function telaEstreita() {
        return !!(window.matchMedia && window.matchMedia('(max-width: 470px)').matches);
    }

    function posicionarNaRegiao(r) {
        if (!mapa) return;
        if (r && r.lat_min !== null && r.lat_min !== undefined) {
            var la1 = parseFloat(r.lat_min), la2 = parseFloat(r.lat_max);
            var ln1 = parseFloat(r.lng_min), ln2 = parseFloat(r.lng_max);
            if (Math.abs(la2 - la1) < 1e-5 && Math.abs(ln2 - ln1) < 1e-5) {
                mapa.setCenter({ lat: la1, lng: ln1 });
                mapa.setZoom(ZOOM_MAX_ENQUADRAR);
                return;
            }
            // Com o painel aberto no desktop, ele cobre 300px da esquerda: a rede é
            // enquadrada no que sobra à vista, não atrás dele.
            var coberto = $('#mapa-area').hasClass('gaveta-aberta') && !telaEstreita();
            mapa.fitBounds(new google.maps.LatLngBounds({ lat: la1, lng: ln1 }, { lat: la2, lng: ln2 }),
                coberto ? { top: 40, right: 40, bottom: 40, left: 340 } : 40);
            google.maps.event.addListenerOnce(mapa, 'idle', function () {
                if (mapa.getZoom() > ZOOM_MAX_ENQUADRAR) mapa.setZoom(ZOOM_MAX_ENQUADRAR);
            });
        } else if (r && r.lat !== null && r.lat !== undefined && r.lng !== null) {
            mapa.setCenter({ lat: parseFloat(r.lat), lng: parseFloat(r.lng) });
            mapa.setZoom(parseInt(r.zoom, 10) || 15);
        } else {
            mapa.setCenter(CENTRO_BRASIL);
            mapa.setZoom(ZOOM_BRASIL);
        }
    }

    function trocarRegiao(id) {
        if (modo !== 'navegar') {
            definirModo('navegar');
            if (modo !== 'navegar') return;     // desistiu de sair do Mover com pendências
        }
        regiao = parseInt(id, 10) || 0;
        desenharClientesMapa([]);
        pontos = [];
        pontosCarregados = false;
        $('#painel').hide();
        renderRegioes();
        aplicarTravas();
        // Escolheu a região: o painel sai da frente ANTES de enquadrar, para a rede ocupar
        // o mapa inteiro em vez de ser enquadrada no que sobra ao lado dele.
        abrirGaveta(false);
        posicionarNaRegiao(acharRegiao(regiao));
        carregar();
    }

    function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

    function renderRegioes() {
        var $l = $('#lista-regioes');
        if (!regioes.length) {
            $l.html('<p class="ftth-gaveta-vazio">Nenhuma região ainda. Crie a primeira: dê um nome '
                + 'e posicione o mapa onde ela fica.</p>');
            return;
        }
        $l.html(regioes.map(function (r) {
            var n = parseInt(r.caixas, 10) || 0;
            var v = parseInt(r.vaos, 10) || 0;
            var q = parseInt(r.quarentena, 10) || 0;
            return '<div class="ftth-regiao' + (Number(r.id) === Number(regiao) ? ' ativa' : '')
                 +      '" data-id="' + r.id + '">'
                 +   '<div class="ftth-regiao-topo">'
                 +     '<div class="ftth-regiao-nome"><strong>' + esc(r.nome) + '</strong>'
                 +       '<span>' + plural(n, 'ponto', 'pontos') + ' · ' + plural(v, 'vão', 'vãos')
                 +       (q ? ' · ' + q + ' a revisar' : '') + '</span></div>'
                 +     '<button type="button" class="ftth-regiao-mais" title="Opções">'
                 +       '<i class="bi-three-dots-vertical"></i></button>'
                 +   '</div>'
                 +   '<div class="ftth-regiao-menu">'
                 +     '<button type="button" data-acao="renomear"><i class="bi-pencil-square"></i> Renomear</button>'
                 +     '<button type="button" data-acao="vista"><i class="bi-crosshair"></i> Usar esta vista como centro</button>'
                 +     '<button type="button" data-acao="excluir" class="perigo">'
                 +       '<i class="bi-trash3-fill"></i> Excluir</button>'
                 +   '</div>'
                 + '</div>';
        }).join(''));
    }

    function recarregarRegioes(depois) {
        FTTH.chamar({
            url: 'mapa.php?ajax=regioes',
            onOk: function (d) {
                regioes = d.regioes || [];
                renderRegioes();
                if (depois) depois();
                avisarMudanca();
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        });
    }

    /* ------------------------------------------------------------------ aba Pontos */

    /**
     * Lista da região inteira, com o filtro que também vale no mapa. Só é buscada quando
     * alguém vai olhar (aba aberta ou filtro ligado): o cálculo de sinal roda a rede toda.
     */
    var pontos = [];
    var pontosCarregados = false;
    var filtroPontos = 'todos';           // todos | sem_sinal | sem_splitter
    var gruposFechados = {};
    var ORDEM_GRUPO = ['CTO', 'CEO', 'DC', 'PREDIO', 'POSTE', 'RESERVA', 'PROBLEMA'];
    var ROTULO_GRUPO = { CTO: 'CTO', CEO: 'CEO', DC: 'DC / POP', PREDIO: 'Prédio',
                         POSTE: 'Postes', RESERVA: 'Reserva', PROBLEMA: 'Problema' };
    var ROTULO_FILTRO = { sem_sinal: 'sem sinal', sem_splitter: 'sem splitter', postes: 'postes' };

    /** Os dois filtros olham só CTO e CEO — e é o servidor quem diz quem é (com_sinal != null). */
    function atendeFiltro(p, f) {
        if (f === 'todos') return true;
        if (f === 'postes') return p.tipo === 'POSTE';
        if (p.com_sinal === null || p.com_sinal === undefined) return false;
        if (f === 'sem_sinal') return !p.com_sinal;
        if (f === 'sem_splitter') return (parseInt(p.splitters, 10) || 0) === 0;
        return true;
    }

    /** Ids que o filtro destaca no mapa, ou null quando não há filtro (nada fica translúcido). */
    function idsDoFiltro() {
        if (filtroPontos === 'todos' || !pontosCarregados) return null;
        var ids = {};
        pontos.forEach(function (p) { if (atendeFiltro(p, filtroPontos)) ids[p.id] = true; });
        return ids;
    }

    function abaPontosVisivel() {
        return $('#mapa-area').hasClass('gaveta-aberta')
            && $('.ftth-gaveta-tab.ativo').data('aba') === 'pontos';
    }

    function recarregarPontos() {
        if (!regiao) {
            pontos = [];
            pontosCarregados = false;
            renderPontos();
            return;
        }
        // Ninguém olhando: só marca como velha, e ela é buscada quando a aba abrir.
        if (filtroPontos === 'todos' && !abaPontosVisivel()) {
            pontosCarregados = false;
            return;
        }
        var pedida = regiao;
        FTTH.chamar({
            url: 'mapa.php?ajax=pontos&regiao=' + regiao,
            onOk: function (d) {
                if (pedida !== regiao) return;       // trocou de região no meio do caminho
                pontos = d.pontos || [];
                pontosCarregados = true;
                renderPontos();
                if (filtroPontos !== 'todos' && ultimoDesenho) desenhar(ultimoDesenho);
            },
            onErro: function (m) {
                $('#lista-pontos').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
            }
        });
    }

    function linhaDoPonto(p) {
        if (p.tipo === 'RESERVA') {
            return '<small>' + (parseFloat(p.reserva_m) > 0 ? metros(p.reserva_m) + ' de reserva'
                                                            : 'sem metros informados') + '</small>';
        }
        if (p.com_sinal === null || p.com_sinal === undefined) {
            return '<small>' + esc(ROTULO_GRUPO[p.tipo] || p.tipo) + '</small>';
        }
        var partes = [];
        var alerta = false;
        if (p.com_sinal) {
            partes.push('com sinal');
        } else {
            partes.push('sem sinal');
            alerta = true;
        }
        var sp = parseInt(p.splitters, 10) || 0;
        var portas = parseInt(p.portas, 10) || 0;
        var ocupadas = parseInt(p.ocupadas, 10) || 0;
        if (!sp) {
            partes.push('sem splitter');
            alerta = true;
        } else if (portas) {
            partes.push(ocupadas + '/' + portas + ' portas');
        } else {
            partes.push(plural(sp, 'splitter', 'splitters'));
        }
        return '<small' + (alerta ? ' class="alerta"' : '') + '>' + partes.join(' · ') + '</small>';
    }

    function renderPontos() {
        var $l = $('#lista-pontos');
        var semSinal = 0, semSplitter = 0;
        pontos.forEach(function (p) {
            if (atendeFiltro(p, 'sem_sinal')) semSinal++;
            if (atendeFiltro(p, 'sem_splitter')) semSplitter++;
        });
        $('#conta-sem-sinal').text(pontosCarregados ? semSinal : '');
        $('#conta-sem-splitter').text(pontosCarregados ? semSplitter : '');
        var postes = pontos.filter(function (p) { return p.tipo === 'POSTE'; }).length;
        $('#conta-postes').text(pontosCarregados ? postes : '');
        var termo = $.trim($('#pontos-busca').val() || '').toLowerCase();
        var filtrando = filtroPontos !== 'todos' || termo !== '';
        $('#gaveta-aba').toggleClass('filtrando', filtrando);
        if (!filtrando || !pontosCarregados) $('#pontos-filtro').hide();

        if (!regiao) {
            $l.html('<p class="ftth-gaveta-vazio">Escolha uma região na aba Regiões.</p>');
            return;
        }
        if (!pontosCarregados) {
            $l.html('<p class="ftth-gaveta-vazio">Carregando…</p>');
            return;
        }

        var grupos = {}, exibidos = 0;
        pontos.forEach(function (p) {
            if (!atendeFiltro(p, filtroPontos)) return;
            if (termo && String(p.nome).toLowerCase().indexOf(termo) < 0) return;
            var g = p.tipo === 'CTO_AP' ? 'CTO' : p.tipo;
            (grupos[g] = grupos[g] || []).push(p);
            exibidos++;
        });
        // Filtro ou busca ligados: o selo embaixo de "Pontos" mostra quantos estão à vista,
        // no mesmo lugar do número das Camadas — a bolinha da aba lateral sozinha passava batido.
        if (filtrando) {
            $('#pontos-filtro').text(exibidos).attr('title', 'Filtro: '
                + (filtroPontos !== 'todos' ? ROTULO_FILTRO[filtroPontos] : 'todos')
                + (termo ? ' · busca "' + termo + '"' : '')).show();
        }
        var ordem = function (g) { var i = ORDEM_GRUPO.indexOf(g); return i < 0 ? 99 : i; };
        var chaves = Object.keys(grupos).sort(function (a, b) { return ordem(a) - ordem(b); });

        if (!chaves.length) {
            $l.html('<p class="ftth-gaveta-vazio">' + (filtroPontos === 'postes'
                ? 'Nenhum poste nesta região.'
                : filtroPontos !== 'todos'
                ? 'Nenhuma CTO ou CEO ' + ROTULO_FILTRO[filtroPontos] + ' nesta região.'
                : (termo ? 'Nenhum ponto com "' + esc(termo) + '".' : 'Nenhum ponto nesta região ainda.'))
                + '</p>');
            return;
        }

        $l.html(chaves.map(function (g) {
            // Buscando, os grupos abrem todos: o resultado não pode ficar escondido.
            var fechado = gruposFechados[g] && !termo;
            return '<div class="ftth-grupo' + (fechado ? ' fechado' : '') + '" data-grupo="' + g + '">'
                 +   '<button type="button" class="ftth-grupo-topo">'
                 +     marcaDoTipo(g, '#4A5568') + ' ' + esc(ROTULO_GRUPO[g] || g)
                 +     ' <span>(' + grupos[g].length + ')</span><i class="bi-chevron-down"></i></button>'
                 +   '<div class="ftth-grupo-itens">'
                 +     grupos[g].map(function (p) {
                          return '<button type="button" class="ftth-item-ponto" data-id="' + p.id + '">'
                               +   marcaDoTipo(p.tipo, p.cor)
                               +   '<span><strong>' + esc(p.nome) + '</strong>' + linhaDoPonto(p) + '</span>'
                               + '</button>';
                       }).join('')
                 +   '</div>'
                 + '</div>';
        }).join(''));
    }

    /** Clique na lista: o mapa vai até o ponto e a ficha abre. No celular o painel sai da frente. */
    function irParaPonto(id) {
        var p = null;
        pontos.forEach(function (x) { if (Number(x.id) === Number(id)) p = x; });
        if (!p || !mapa) return;
        if (telaEstreita()) abrirGaveta(false);
        mapa.setCenter({ lat: parseFloat(p.lat), lng: parseFloat(p.lng) });
        if (mapa.getZoom() < 19) mapa.setZoom(19);
        abrirFicha(p.id);
    }

    function escolherFiltro(f) {
        filtroPontos = f;
        $('.ftth-filtro').removeClass('ativo').filter('[data-filtro="' + f + '"]').addClass('ativo');
        renderPontos();
        if (!pontosCarregados) {
            recarregarPontos();          // o mapa é redesenhado quando a lista chegar
        } else if (ultimoDesenho) {
            desenhar(ultimoDesenho);     // liga/desliga a transparência sem ir ao servidor
        }
    }

    /* ------------------------------------------------------------------ aba Ajustes */

    var estadoLido = false;

    function carregarEstado() {
        if (estadoLido) return;
        FTTH.chamar({
            url: 'mapa.php?ajax=estado',
            onOk: function (e) {
                estadoLido = true;
                $('#estado-banco').html(
                    '<div class="ftth-estado-topo"><strong>Estado do banco</strong>'
                  +   '<span class="ftth-selo ' + (e.completo ? 'ftth-selo--ok">completo' : 'ftth-selo--erro">incompleto')
                  +   '</span></div>'
                  + '<dl class="ftth-estado-dados">'
                  +   '<dt>Tabelas do addon</dt><dd>' + e.tabelas + ' de ' + e.tabelas_de + '</dd>'
                  +   '<dt>Schema aplicado</dt><dd>' + (e.schema ? esc(e.schema) + ' em ' + esc(e.schema_em) : '—') + '</dd>'
                  +   '<dt>Versão do addon</dt><dd>' + esc(e.addon || '—') + '</dd>'
                  +   (e.aposentadas ? '<dt>Aposentadas</dt><dd>' + e.aposentadas + ' a remover</dd>' : '')
                  + '</dl>'
                  + '<div class="ftth-estado-atualizacao" id="estado-atualizacao" aria-live="polite">'
                  +   '<button type="button" class="ftth-onb-link" id="estado-verificar">'
                  +     '<i class="bi-arrow-repeat"></i> Verificar atualização</button></div>');
                estadoAtual = e;
                if (e.atualizador && (e.atualizador.estado === 'pending' || e.atualizador.estado === 'running')) {
                    acompanharAtualizacao();
                }
            },
            onErro: function (m) {
                $('#estado-banco').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
            }
        });
    }

    var estadoAtual = null;   // o último estado lido: versão instalada, instalador, release
    var timerAtualizacao = null;
    var recargaAtualizacaoAgendada = false;

    /** "0.9.10" > "0.9.9": compara número a número, não como texto. */
    function versaoMaior(a, b) {
        var pa = String(a).replace(/^v/i, '').split('.');
        var pb = String(b).replace(/^v/i, '').split('.');
        for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
            if (x !== y) return x > y;
        }
        return false;
    }

    function htmlInstaladorManual(texto) {
        var comando = estadoAtual && estadoAtual.instalador ? estadoAtual.instalador : '';
        if (!comando) return '';
        return '<p class="ftth-sub" style="margin:6px 0 4px">' + esc(texto) + '</p>'
            + '<div class="ftth-estado-cmd"><code id="estado-cmd">' + esc(comando) + '</code>'
            +   '<button type="button" class="ftth-copiar" id="estado-copiar">copiar</button></div>';
    }

    /**
     * Pergunta ao GitHub qual é a última release — a mesma que o instalador baixaria. Sai do
     * navegador, e só quando alguém clica: o servidor do provedor não precisa de internet para
     * isso, e o addon não fica consultando nada por conta própria.
     */
    function verificarAtualizacao() {
        var e = estadoAtual;
        var $a = $('#estado-atualizacao');
        if (!e || !e.ultima_url) return;
        $a.html('<span class="ftth-sub" style="margin:0"><i class="bi-arrow-repeat"></i> Consultando o GitHub…</span>');

        $.ajax({ url: e.ultima_url, dataType: 'json', timeout: 10000, cache: false })
            .done(function (r) {
                var tag = String((r && r.tag_name) || '');
                if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) || !r || r.draft || r.prerelease) { falhou(); return; }
                var ultima = tag.slice(1);
                if (!versaoMaior(ultima, e.addon)) {
                    var atual = '<span class="ftth-estado-ok"><i class="bi-check-circle-fill"></i> '
                        + 'Você está na versão mais recente (' + esc(e.addon) + ').</span>';
                    if (!e.atualizador || !e.atualizador.configurado) {
                        atual += htmlInstaladorManual('Para habilitar o botão, rode uma vez o instalador como root no servidor:');
                    }
                    $a.html(atual);
                    return;
                }
                var data = r.published_at ? new Date(r.published_at).toLocaleDateString('pt-BR') : '';
                var nomePacote = 'ftth_doc-' + ultima + '.tar.gz';
                var digest = '';
                (Array.isArray(r.assets) ? r.assets : []).forEach(function (asset) {
                    if (asset && asset.name === nomePacote) digest = String(asset.digest || '');
                });
                var pacoteVerificado = /^sha256:[a-f0-9]{64}$/i.test(digest);
                var html = '<div class="ftth-estado-novo"><i class="bi-arrow-up-circle-fill"></i> '
                    + 'Versão <strong>' + esc(ultima) + '</strong> disponível'
                    + (data ? ' (' + esc(data) + ')' : '')
                    + (r.html_url ? ' · <a href="' + esc(r.html_url) + '" target="_blank" rel="noopener">o que mudou</a>' : '')
                    + '</div>';

                if (e.atualizador && e.atualizador.configurado && pacoteVerificado) {
                    html += '<p class="ftth-sub" style="margin:4px 0">O instalador fará backup antes de aplicar a atualização.</p>'
                        + '<button type="button" class="ftth-onb-link ftth-atualizar-agora" id="estado-atualizar"'
                        + ' data-versao="' + esc(ultima) + '"><i class="bi-cloud-arrow-down"></i> Atualizar agora</button>';
                } else {
                    html += htmlInstaladorManual(e.atualizador && e.atualizador.configurado
                        ? 'A release não publicou um digest verificável. Use o instalador manual:'
                        : 'Para habilitar o botão, rode uma vez o instalador como root no servidor:');
                }
                $a.html(html);
            })
            .fail(falhou);

        function falhou() {
            $a.html('<span class="ftth-sub" style="margin:0">Não foi possível consultar o GitHub agora. '
                + '<button type="button" class="ftth-onb-link" id="estado-verificar">Tentar de novo</button></span>');
        }
    }

    function solicitarAtualizacao(versao) {
        var cfg = window.FTTH_MAPA || {};
        if (!window.confirm('Atualizar o FTTH Doc para a versão ' + versao + '? O instalador fará backup do código e do banco antes de aplicar as mudanças.')) return;

        $('#estado-atualizar').prop('disabled', true).attr('aria-busy', 'true');
        $('#estado-atualizacao').html('<span class="ftth-sub" role="status" style="margin:0"><i class="bi-arrow-repeat"></i> Enviando solicitação…</span>');
        FTTH.chamar({
            url: 'mapa.php?ajax=atualizar_solicitar',
            method: 'POST',
            data: { csrf: cfg.csrf },
            onOk: function () { acompanharAtualizacao(); },
            onErro: function (mensagem) {
                $('#estado-atualizacao').html('<span class="ftth-aviso ftth-aviso--erro" role="alert">'
                    + esc(mensagem) + '</span>'
                    + htmlInstaladorManual('Se o auxiliar não responder, use o instalador manual:'));
            }
        });
    }

    function acompanharAtualizacao() {
        if (timerAtualizacao) window.clearTimeout(timerAtualizacao);
        var inicio = Date.now();

        function consultar() {
            FTTH.chamar({
                url: 'mapa.php?ajax=atualizador_estado',
                onOk: function (estado) {
                    if (estado.estado === 'succeeded') {
                        if (timerAtualizacao) window.clearTimeout(timerAtualizacao);
                        $('#estado-atualizacao').html('<span class="ftth-estado-ok" role="status"><i class="bi-check-circle-fill"></i> '
                            + 'Atualização concluída para ' + esc(estado.versao || 'a versão mais recente') + '. Recarregando…</span>');
                        if (!recargaAtualizacaoAgendada) {
                            recargaAtualizacaoAgendada = true;
                            window.setTimeout(function () { window.location.reload(); }, 1800);
                        }
                        return;
                    }
                    if (estado.estado === 'failed') {
                        if (timerAtualizacao) window.clearTimeout(timerAtualizacao);
                        $('#estado-atualizacao').html('<span class="ftth-aviso ftth-aviso--erro" role="alert">'
                            + esc(estado.mensagem || 'A atualização falhou.') + '</span>'
                            + '<button type="button" class="ftth-onb-link" id="estado-verificar">Verificar novamente</button>'
                            + htmlInstaladorManual('Confira o log do servidor ou use o instalador manual:'));
                        return;
                    }
                    if (Date.now() - inicio > 900000) {
                        $('#estado-atualizacao').html('<span class="ftth-sub" role="status">'
                            + 'A tarefa ainda não terminou. Confira o estado novamente em instantes.</span>'
                            + htmlInstaladorManual('Se o auxiliar não responder, use o instalador manual:'));
                        return;
                    }
                    var texto = estado.estado === 'running' ? 'Instalando a atualização…' : 'Na fila de atualização…';
                    $('#estado-atualizacao').html('<span class="ftth-sub" role="status" style="margin:0"><i class="bi-arrow-repeat"></i> '
                        + texto + '</span>');
                    timerAtualizacao = window.setTimeout(consultar, 3000);
                },
                onErro: function () {
                    if (Date.now() - inicio > 900000) {
                        $('#estado-atualizacao').html('<span class="ftth-sub" role="status">'
                            + 'Não foi possível consultar o andamento. Confira o estado novamente em instantes.</span>'
                            + htmlInstaladorManual('Se precisar, use o instalador manual:'));
                        return;
                    }
                    timerAtualizacao = window.setTimeout(consultar, 5000);
                }
            });
        }

        consultar();
    }

    /**
     * Salvar: o que pode valer na hora vale — tipo de mapa e zoom do rótulo redesenham o mapa;
     * o raio de emenda o servidor já lê a cada uso. Só a chave do Google pede recarregar.
     */
    function salvarAjustes() {
        var cfg = window.FTTH_MAPA || {};
        var chaveAntes = String($('#aj-chave').data('salva') !== undefined
            ? $('#aj-chave').data('salva') : $('#aj-chave').prop('defaultValue'));
        var $b = $('#aj-salvar').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=ajustes',
            method: 'POST',
            data: {
                csrf: cfg.csrf,
                google_maps_key: $('#aj-chave').val(),
                mapa_tipo: $('#aj-tipo').val(),
                // Sem raio_quebra_cabo_m: o campo saiu da tela, e mandá-lo vazio gravaria 1 m.
                mapa_rotulo_zoom: $('#aj-zoom').val()
            },
            onOk: function (d) {
                $('#aj-chave').data('salva', d.google_maps_key);
                $('#aj-zoom').val(d.mapa_rotulo_zoom);

                cfg.rotulo_zoom = d.mapa_rotulo_zoom;
                if (mapa && d.mapa_tipo !== cfg.tipo) {
                    cfg.tipo = d.mapa_tipo;
                    // Híbrido é satélite + a camada de rótulos, que o listener de tipo liga sozinho.
                    mapa.setMapTypeId(d.mapa_tipo === 'hybrid' ? 'satellite' : d.mapa_tipo);
                }
                if (ultimoDesenho) desenhar(ultimoDesenho);

                var trocouChave = d.google_maps_key !== chaveAntes;
                $('#aj-saida').html('<div class="ftth-aviso ftth-aviso--ok" style="margin:8px 0 0">'
                    + 'Ajustes salvos.' + (trocouChave ? ' A chave nova vale ao recarregar a página.' : '')
                    + '</div>');
            },
            onErro: function (m) {
                $('#aj-saida').html('<div class="ftth-aviso ftth-aviso--erro" style="margin:8px 0 0">'
                    + esc(m) + '</div>');
            }
        }).always(function () { $b.prop('disabled', false); });
    }

    /* Preferência do painel (aberto, aba): conveniência deste navegador, nada além disso. */
    function lerPref(chave) {
        try { return localStorage.getItem(chave); } catch (e) { return null; }
    }
    function gravarPref(chave, valor) {
        try { localStorage.setItem(chave, valor); } catch (e) { /* sem storage: não lembra */ }
    }

    function abrirGaveta(aberta) {
        $('#mapa-area').toggleClass('gaveta-aberta', !!aberta);
        gravarPref('ftth_gaveta', aberta ? '1' : '0');
        if (abaPontosVisivel() && !pontosCarregados) recarregarPontos();
        if (aberta && $('.ftth-gaveta-tab.ativo').data('aba') === 'ajustes') carregarEstado();
    }

    function escolherAba(aba) {
        if (!$('.ftth-gaveta-tab[data-aba="' + aba + '"]').length) aba = 'regioes';
        $('.ftth-gaveta-tab').removeClass('ativo').filter('[data-aba="' + aba + '"]').addClass('ativo');
        $('.ftth-gaveta-corpo').hide().filter('[data-aba="' + aba + '"]').show();
        gravarPref('ftth_gaveta_aba', aba);
        if (abaPontosVisivel() && !pontosCarregados) recarregarPontos();
        if (aba === 'clientes') carregarClientesSemLocalizacao(true);
        if (aba === 'ajustes' && $('#mapa-area').hasClass('gaveta-aberta')) carregarEstado();
    }

    /** Nome da região: o mesmo modal cria (passo 1) e renomeia. */
    var regiaoEditando = null;   // null = nova; senão, a região sendo renomeada

    function abrirModalRegiao(r) {
        regiaoEditando = r || null;
        $('#rg-titulo').text(r ? 'Renomear região' : 'Nova região');
        $('#rg-salvar').text(r ? 'Salvar' : 'Continuar');
        $('#rg-nota').text(r ? '' : 'Depois do nome, você posiciona o mapa onde a região fica.');
        $('#rg-nome').val(r ? r.nome : '');
        $('#rg-saida').empty();
        $('#modal-regiao').show();
        setTimeout(function () { $('#rg-nome').trigger('focus').trigger('select'); }, 50);
    }

    /** Por que este nome não serve ('' = serve). O modal e os primeiros passos usam a mesma regra. */
    function recusaNomeRegiao(nome, editandoRegiao) {
        if (!nome) return 'Informe o nome da região.';
        var repetida = regioes.some(function (x) {
            return x.nome.toLowerCase() === nome.toLowerCase()
                && (!editandoRegiao || Number(x.id) !== Number(editandoRegiao.id));
        });
        return repetida ? 'Já existe uma região com esse nome.' : '';
    }

    function salvarModalRegiao() {
        var cfg = window.FTTH_MAPA || {};
        var nome = $.trim($('#rg-nome').val());
        var erro = function (m) {
            $('#rg-saida').html('<div class="ftth-aviso ftth-aviso--erro" style="margin:8px 0 0">'
                + esc(m) + '</div>');
        };
        var recusa = recusaNomeRegiao(nome, regiaoEditando);
        if (recusa) { erro(recusa); return; }

        if (!regiaoEditando) {
            $('#modal-regiao').hide();
            iniciarPosicionamento(nome);
            return;
        }

        $('#rg-salvar').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=regiao_alterar',
            method: 'POST',
            data: { csrf: cfg.csrf, id: regiaoEditando.id, versao: regiaoEditando.versao, nome: nome },
            onOk: function () {
                $('#modal-regiao').hide();
                recarregarRegioes();
            },
            onErro: erro
        }).always(function () { $('#rg-salvar').prop('disabled', false); });
    }

    /** Nova região, passo 2: o usuário leva o mapa até a região e confirma. */
    var nomeNovaRegiao = null;

    function iniciarPosicionamento(nome) {
        definirModo('navegar');
        if (modo !== 'navegar') return;
        nomeNovaRegiao = nome;
        $('#painel').hide();
        abrirGaveta(false);
        $('#regiao-card-nome').text(nome);
        $('#regiao-card').show();
        ajustarToasts();
        // Com o assistente na tela a dica já está no balão, fixa; o toast sumiria sozinho.
        if (!$('#onb-balao').is(':visible') && !$('#onb').is(':visible')) {
            FTTH.toast('info', 'Arraste e aproxime o mapa até ' + nome + ' (ou busque a coordenada) e confirme.');
        }
        avisarMudanca();
    }

    function encerrarPosicionamento() {
        nomeNovaRegiao = null;
        $('#regiao-card').hide();
        ajustarToasts();
        avisarMudanca();
    }

    function confirmarNovaRegiao() {
        var cfg = window.FTTH_MAPA || {};
        var c = mapa.getCenter();
        var $b = $('#regiao-card-confirmar').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=regiao_criar',
            method: 'POST',
            data: { csrf: cfg.csrf, nome: nomeNovaRegiao, lat: c.lat(), lng: c.lng(), zoom: mapa.getZoom() },
            onOk: function (d) {
                var nome = nomeNovaRegiao;
                encerrarPosicionamento();
                recarregarRegioes(function () { trocarRegiao(d.id); });
                FTTH.toast('ok', 'Região ' + nome + ' criada.');
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        }).always(function () { $b.prop('disabled', false); });
    }

    function usarVistaComoCentro(r) {
        var cfg = window.FTTH_MAPA || {};
        var n = parseInt(r.caixas, 10) || 0;
        var msg = 'Gravar a vista atual do mapa como centro de "' + r.nome + '"?'
            + (n ? '\n\nEla já tem pontos: ao entrar nela o mapa enquadra os pontos, e este '
                 + 'centro só vale se ela ficar vazia.' : '');
        if (!confirm(msg)) return;
        var c = mapa.getCenter();
        FTTH.chamar({
            url: 'mapa.php?ajax=regiao_alterar',
            method: 'POST',
            data: { csrf: cfg.csrf, id: r.id, versao: r.versao,
                    lat: c.lat(), lng: c.lng(), zoom: mapa.getZoom() },
            onOk: function () {
                recarregarRegioes();
                FTTH.toast('ok', 'Centro de ' + r.nome + ' atualizado.');
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        });
    }

    function excluirRegiao(r) {
        var cfg = window.FTTH_MAPA || {};
        if (!confirm('Excluir a região "' + r.nome + '"?\n\nSó é possível com ela vazia.')) return;
        FTTH.chamar({
            url: 'mapa.php?ajax=regiao_excluir',
            method: 'POST',
            data: { csrf: cfg.csrf, id: r.id, versao: r.versao },
            onOk: function () {
                var eraAtual = Number(r.id) === Number(regiao);
                recarregarRegioes(function () {
                    if (!eraAtual) return;
                    if (regioes.length) {
                        trocarRegiao(regioes[0].id);
                    } else {
                        regiao = 0;
                        aplicarTravas();
                        limpar();
                        $('#resumo-mapa').empty();
                        posicionarNaRegiao(null);
                    }
                });
                FTTH.toast('ok', 'Região ' + r.nome + ' excluída.');
            },
            onErro: function (m) { FTTH.toast('erro', m); }
        });
    }

    function iniciarGaveta() {
        renderRegioes();
        escolherAba(lerPref('ftth_gaveta_aba') || 'regioes');
        // Sem região não há o que fazer no mapa: o painel já abre mostrando como criar uma.
        // No celular ele não reabre sozinho, porque cobriria o mapa inteiro.
        if (!regioes.length) {
            escolherAba('regioes');
            abrirGaveta(true);
        } else {
            abrirGaveta(lerPref('ftth_gaveta') === '1' && !telaEstreita());
        }

        $('#gaveta-aba').on('click', function () {
            abrirGaveta(!$('#mapa-area').hasClass('gaveta-aberta'));
        });
        $('.ftth-gaveta-tab').on('click', function () { escolherAba($(this).data('aba')); });

        var $lista = $('#lista-regioes');
        $lista.on('click', '.ftth-regiao-topo', function (ev) {
            if ($(ev.target).closest('.ftth-regiao-mais').length) return;
            trocarRegiao($(this).closest('.ftth-regiao').data('id'));
        });
        $lista.on('click', '.ftth-regiao-mais', function () {
            var $r = $(this).closest('.ftth-regiao');
            $lista.find('.ftth-regiao').not($r).removeClass('menu-aberto');
            $r.toggleClass('menu-aberto');
        });
        $lista.on('click', '.ftth-regiao-menu button', function () {
            var r = acharRegiao($(this).closest('.ftth-regiao').data('id'));
            $(this).closest('.ftth-regiao').removeClass('menu-aberto');
            if (!r) return;
            var acao = $(this).data('acao');
            if (acao === 'renomear') abrirModalRegiao(r);
            else if (acao === 'vista') usarVistaComoCentro(r);
            else if (acao === 'excluir') excluirRegiao(r);
        });

        $('#regiao-nova').on('click', function () { abrirModalRegiao(null); });

        // --- aba Ajustes
        $('#aj-salvar').on('click', salvarAjustes);
        $('#estado-banco').on('click', '#estado-verificar', verificarAtualizacao);
        $('#estado-banco').on('click', '#estado-atualizar', function () {
            solicitarAtualizacao(String($(this).data('versao') || 'mais recente'));
        });
        $('#estado-banco').on('click', '#estado-copiar', function () {
            var texto = $('#estado-cmd').text();
            var $b = $(this);
            if (navigator.clipboard) {
                navigator.clipboard.writeText(texto).then(function () { $b.text('copiado'); });
            } else {
                window.prompt('Copie o comando:', texto);
            }
        });

        // --- aba Pontos
        renderPontos();
        $('#pontos-busca').on('input', renderPontos);
        $('.ftth-filtro').on('click', function () { escolherFiltro($(this).data('filtro')); });
        var $pontos = $('#lista-pontos');
        $pontos.on('click', '.ftth-grupo-topo', function () {
            var $g = $(this).closest('.ftth-grupo');
            $g.toggleClass('fechado');
            gruposFechados[$g.data('grupo')] = $g.hasClass('fechado');
        });
        $pontos.on('click', '.ftth-item-ponto', function () { irParaPonto($(this).data('id')); });
        $('#rg-salvar').on('click', salvarModalRegiao);
        $('#rg-nome').on('keydown', function (e) { if (e.key === 'Enter') salvarModalRegiao(); });
        $('#rg-cancelar, #rg-fechar').on('click', function () { $('#modal-regiao').hide(); });
        $('#regiao-card-confirmar').on('click', confirmarNovaRegiao);
        $('#regiao-card-cancelar').on('click', function () {
            encerrarPosicionamento();
            abrirGaveta(true);
        });
    }

    window.ftthIniciarMapa = function () {
        var cfg = window.FTTH_MAPA || {};
        regiao = cfg.regiao || 0;
        otdrPreviewActive = !!(cfg.otdr || cfg.foco_vao);

        regioes = cfg.regioes || [];

        // Prioridade 1: a vista guardada na aba (volta do diagrama, F5), se a região dela
        // ainda existe. Sem ela, a região é posicionada logo depois de o mapa nascer.
        var visualizacaoInicial = cfg.otdr || cfg.foco_vao;
        var vista = visualizacaoInicial ? null : lerVista();
        if (visualizacaoInicial && acharRegiao(visualizacaoInicial.regiao_id)) {
            regiao = parseInt(visualizacaoInicial.regiao_id, 10);
        } else if (vista && acharRegiao(vista.regiao)) {
            regiao = parseInt(vista.regiao, 10);
        } else {
            vista = null;
        }

        ajustarAltura();
        window.addEventListener('resize', ajustarAltura);
        window.addEventListener('resize', ajustarToasts);
        // A dica longa do modo Mover, que em tela estreita sai do card.
        $('#mover-ajuda').on('click', function () {
            FTTH.toast('info', $.trim($('#mover-dica').text()));
        });

        var tipo = cfg.tipo || 'hybrid';

        mapa = new google.maps.Map(document.getElementById('mapa'), {
            center: visualizacaoInicial ? { lat: Number(visualizacaoInicial.lat), lng: Number(visualizacaoInicial.lng) }
                : (vista ? { lat: vista.lat, lng: vista.lng } : CENTRO_BRASIL),
            zoom: visualizacaoInicial ? 18 : (vista ? vista.zoom : ZOOM_BRASIL),
            // Tipo de mapa vem de tab_ftth_config (mapa_tipo). Padrão: híbrido — satélite
            // com nome de rua, que é o que serve para o técnico em campo.
            //
            // Em satélite e híbrido o Google IGNORA `styles` — não há como esconder os POIs
            // por ali. Por isso o híbrido é montado à mão logo abaixo: satélite puro (que
            // não tem POI nenhum) mais uma camada só de rótulos.
            mapTypeId: tipo === 'hybrid' ? 'satellite' : tipo,
            mapTypeControl: true,
            streetViewControl: true,
            fullscreenControl: true,
            gestureHandling: 'greedy',
            styles: estilosGoogle()
        });

        // A camada de rótulos: geometria desligada deixa os tiles transparentes, então o
        // satélite continua aparecendo por baixo e só nome de rua e bairro ficam por cima.
        rotulosGoogle = new google.maps.StyledMapType([
            { elementType: 'geometry', stylers: [{ visibility: 'off' }] },
            { featureType: 'poi',      stylers: [{ visibility: 'off' }] },
            { featureType: 'transit',  stylers: [{ visibility: 'off' }] },
            { featureType: 'administrative', elementType: 'geometry',
              stylers: [{ visibility: 'off' }] }
        ], { name: 'rotulos' });

        atualizarRotulosGoogle();
        mapa.addListener('maptypeid_changed', atualizarRotulosGoogle);

        // Só busca depois que o usuário parou de mexer — evita uma consulta por pixel.
        mapa.addListener('idle', function () {
            guardarVista();
            clearTimeout(esperando);
            esperando = setTimeout(function () { carregar(true); }, 250);
        });

        // Clique no mapa (fora de qualquer item): ancora a caixa em espera, ou fecha a ficha.
        // Clique em marcador ou em cabo não chega aqui.
        mapa.addListener('click', cliqueNoMapa);

        if (cfg.otdr) {
            var pontoOtdr = { lat: Number(cfg.otdr.lat), lng: Number(cfg.otdr.lng) };
            otdrMarcador = new google.maps.Marker({
                position: pontoOtdr,
                map: mapa,
                title: 'Ponto estimado — confirmar em campo',
                label: { text: 'E', color: '#FFFFFF', fontSize: '11px', fontWeight: '700' },
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: 10,
                        fillColor: '#FF1744', fillOpacity: 1,
                        strokeColor: '#FFFFFF', strokeWeight: 2 },
                zIndex: Z_CAIXA + 100
            });
            if (Array.isArray(cfg.otdr.faixa) && cfg.otdr.faixa.length > 1) {
                otdrFaixa = new google.maps.Polyline({
                    map: mapa,
                    path: cfg.otdr.faixa.map(function (p) { return { lat: Number(p[0]), lng: Number(p[1]) }; }),
                    geodesic: true,
                    strokeColor: '#FF1744',
                    strokeOpacity: 0.34,
                    strokeWeight: 14,
                    clickable: false,
                    zIndex: Z_CAIXA + 99
                });
            }
            var conteudoOtdr = document.createElement('div');
            conteudoOtdr.className = 'ftth-otdr-info';
            var tituloOtdr = document.createElement('strong');
            tituloOtdr.textContent = 'Ponto estimado — confirmar em campo';
            var distanciaOtdr = document.createElement('span');
            distanciaOtdr.textContent = 'Leitura OTDR: '
                + Number(cfg.otdr.metros).toLocaleString('pt-BR') + ' m';
            var corrigidoOtdr = document.createElement('span');
            corrigidoOtdr.textContent = 'Após descontar bobina ('
                + Number(cfg.otdr.bobina).toLocaleString('pt-BR') + ' m): '
                + Number(cfg.otdr.corrigido).toLocaleString('pt-BR') + ' m';
            conteudoOtdr.appendChild(tituloOtdr);
            conteudoOtdr.appendChild(distanciaOtdr);
            conteudoOtdr.appendChild(corrigidoOtdr);
            if (Number(cfg.otdr.margem) > 0) {
                var margemOtdr = document.createElement('span');
                margemOtdr.textContent = 'Faixa aproximada ao longo da rota: ±'
                    + Number(cfg.otdr.margem).toLocaleString('pt-BR')
                    + ' m (traçado destacado não comprova rompimento físico)';
                conteudoOtdr.appendChild(margemOtdr);
            }
            otdrInfo = new google.maps.InfoWindow({ content: conteudoOtdr });
            otdrInfo.open({ map: mapa, anchor: otdrMarcador });
        }

        $('.ftth-modo').on('click', function () {
            if ($(this).prop('disabled')) return;
            if ($(this).hasClass('bloqueado')) {
                FTTH.toast('info', $(this).attr('title'));
                return;
            }
            definirModo($(this).data('modo'));
        });
        if (cfg.passos) {
            travas = { pop: !!cfg.passos.feitos.pop };
        }
        aplicarTravas();

        // Trocar tipo ou cor atualiza o pino que já está no mapa, para o usuário ver o resultado.
        $(document).on('click', '.ftth-tipo', function () {
            $('.ftth-tipo').removeClass('ativo');
            $(this).addClass('ativo');
            camposDoTipo();
            // Na edição o nome é o que o ponto já tem; sugerir outro apagaria o dele.
            if (!editando || editando.virar) sugerirNome('');
            if (pinTemporario) pinTemporario.setIcon(icone(tipoSelecionado(), corSelecionada(), true));
        });
        $(document).on('click', '.ftth-cor', function () {
            $('.ftth-cor').removeClass('ativo');
            $(this).addClass('ativo');
            if (pinTemporario) pinTemporario.setIcon(icone(tipoSelecionado(), corSelecionada(), true));
        });

        // Modo Selecionar: card do desenho da área, barra da seleção e modal de exclusão.
        $('#sel-desfazer').on('click', function () {
            areaSel.pop();
            atualizarArea();
        });
        $('#sel-concluir').on('click', concluirArea);
        $('#sel-cancelar').on('click', function () { definirModo('navegar'); });
        $('#sel-nova').on('click', iniciarSelecao);
        $('#sel-excluir').on('click', abrirExclusaoLote);
        $('#sel-cor').on('click', abrirCorLote);
        $('#sel-exportar').on('click', exportarSelecao);
        // Exportar KMZ (aba Ajustes)
        $('#exp-abrir').on('click', abrirExportar);
        $('.exp-tipo, #exp-todas').on('change', contarExportacao);
        $('#exp-todos').on('click', function () {
            $('.exp-tipo').prop('checked', $('.exp-tipo:not(:checked)').length > 0);
            contarExportacao();
        });
        $('#exp-baixar').on('click', function () {
            baixarKmz(dadosExportacao(), $(this), function () { $('#modal-exportar').hide(); });
        });
        $('#exp-cancelar, #exp-fechar').on('click', function () { $('#modal-exportar').hide(); });
        // A paleta daqui é só deste modal: o stopPropagation impede que o handler geral das
        // .ftth-cor (o do cadastro de ponto) mexa na cor escolhida lá.
        $('#lc-cores, #lc-cores-cabo').on('click', '.ftth-cor', function (e) {
            e.stopPropagation();
            $(e.delegateTarget).find('.ftth-cor').removeClass('ativo');
            $(this).addClass('ativo');
            $('#lc-aplicar').prop('disabled', false);
        });
        $('#lc-aplicar').on('click', aplicarCorLote);
        $('#lc-cancelar, #lc-fechar').on('click', function () { $('#modal-cor-lote').hide(); });
        $('#lote-excluir').on('click', confirmarExclusaoLote);
        $('#lote-confirmacao').on('keydown', function (e) { if (e.key === 'Enter') confirmarExclusaoLote(); });
        $('#lote-cancelar, #lote-fechar').on('click', function () { $('#modal-lote').hide(); });

        // Card flutuante do traçado
        $('#cabo-desfazer').on('click', function () {
            if (continuando && tracado.length <= 1) return;   // a ponta de partida fica
            tracado.pop();
            atualizarTracado();
        });
        $('#cabo-finalizar').on('click', finalizarTracado);
        $('#medir-limpar').on('click', limparMedicao);
        $('#medir-fechar').on('click', function () { definirModo('navegar'); });
        // Cancelar é o par do Finalizar, como no modo edição: os dois encerram o desenho.
        $('#cabo-cancelar').on('click', function () {
            if (tracado.length && !confirm('Descartar o traçado e sair do modo Cabo?')) return;
            limparTracado();
            definirModo('navegar');
        });
        $('#cb-salvar').on('click', confirmarConfigCabo);
        $('#cabo-config').on('click', abrirConfigCabo);
        // Antes de desenhar, fechar o popup é desistir do cabo; desenhando, é só voltar ao
        // traçado, que continua na tela.
        $('#cb-cancelar, #cabo-modal-fechar').on('click', function () {
            $('#modal-cabo').hide();
            if (!desenhandoCabo()) definirModo('navegar');
        });
        $(document).on('click', '#cb-cores .ftth-cor', function () {
            $('#cb-cores .ftth-cor').removeClass('ativo');
            $(this).addClass('ativo');
            atualizarTracado();
        });
        $('#cb-espessura').on('change', atualizarTracado);

        // Ficha do cabo: as ações agem sobre o vão que está aberto no painel.
        $(document).on('click', '#fb-editar', function () {
            if (caboAberto) editarCabo(caboAberto);
        });
        $(document).on('click', '#fb-excluir', function () {
            if (caboAberto) excluirCabo(caboAberto);
        });
        $('#xc-excluir').on('click', confirmarExclusaoCabo);
        $('#xc-cancelar, #xc-fechar').on('click', function () {
            $('#modal-excluir-cabo').hide();
            caboExcluindo = null;
        });
        $(document).on('click', '#fb-centralizar', function () { enquadrarVao(caboAberto); });

        $('#ec-salvar').on('click', salvarEdicaoCabo);
        $('#ec-cancelar, #ec-fechar').on('click', function () {
            $('#modal-editar-cabo').hide();
        });
        $(document).on('click', '#ec-cores .ftth-cor', function () {
            $('#ec-cores .ftth-cor').removeClass('ativo');
            $(this).addClass('ativo');
        });

        $('#nc-criar').on('click', salvarCaixa);
        $('#nc-nome').on('keydown', function (e) { if (e.key === 'Enter') salvarCaixa(); });
        // Cancelar tira o pino provisório mas mantém o modo Caixa: quase sempre o usuário
        // só errou o ponto e vai clicar de novo.
        $('#nc-cancelar, #modal-fechar').on('click', function () {
            $('#modal-caixa').hide();
            if (editando) {
                editando = null;          // saiu da edição: o mapa continua como estava
                return;
            }
            // Desistiu da caixa: a emenda que ele tinha aceitado no clique morre junto.
            emendaDesejada = null;
            limparPin();
            FTTH.toast('info', 'Clique no mapa para marcar o ponto.');
        });
        $(document).on('keydown', function (e) { if (e.key === 'Escape') definirModo('navegar'); });

        iniciarGaveta();
        if (!vista && !cfg.otdr && !cfg.foco_vao) posicionarNaRegiao(acharRegiao(regiao));

        $('.cam').on('change', function () {
            camadas[this.value] = this.checked;
            camadasMudaram(this.value);
        });
        // Marcar/Desmarcar todos: uma gravação e um redesenho só, não um por camada.
        $('#cam-todas').on('click', function (e) {
            e.stopPropagation();   // o menu de camadas fecha com clique fora dele
            var marcar = $('.cam:not(:checked)').length > 0;
            $('.cam').each(function () {
                this.checked = marcar;
                camadas[this.value] = marcar;
            });
            camadasMudaram('TODAS');
        });

        // O menu de camadas fica aberto enquanto se marcam várias de uma vez; fecha ao
        // clicar fora. Sem o stopPropagation, o próprio clique no botão fecharia de volta.
        // --- clientes na porta
        $(document).on('click', '#fc-clientes', function () {
            abrirClientes(parseInt($(this).data('id'), 10));
        });
        $('#cl-fechar, #cl-cancelar').on('click', function () {
            $('#modal-clientes').hide();
            atualizarFichaAberta();
        });

        // --- rota óptica
        $(document).on('click', '#fc-sinal', function () {
            abrirRota(parseInt($(this).data('id'), 10), $(this).data('nome'));
        });
        $('#rt-fechar, #rt-cancelar').on('click', function () {
            $('#modal-rota').hide();
        });

        // A busca dispara depois que o usuário para de digitar: uma consulta por tecla
        // varreria os 800 clientes do cadastro a cada letra.
        var timerCliente = null;
        $(document).on('input', '.js-busca-cliente', function () {
            var $campo = $(this);
            var $lista = $campo.next('.ftth-porta-lista');
            var termo  = $campo.val();

            clearTimeout(timerCliente);
            if (termo.length < 2) { $lista.empty(); return; }

            timerCliente = setTimeout(function () {
                FTTH.chamar({
                    url: 'mapa.php?ajax=buscar_cliente&q=' + encodeURIComponent(termo),
                    onOk: function (d) {
                        $lista.html(htmlResultadosCliente(d.clientes || []));
                        // Nas últimas portas a lista nasce abaixo da área visível do
                        // modal, que rola: sem isto o usuário digitaria e não veria nada.
                        if ($lista[0] && $lista[0].scrollIntoView) {
                            $lista[0].scrollIntoView({ block: 'nearest' });
                        }
                    },
                    onErro: function (m) { $lista.html('<div class="ftth-porta-item">' + esc(m) + '</div>'); }
                });
            }, 300);
        });

        $(document).on('click', '.js-escolher-cliente', function () {
            var $linha = $(this).closest('.ftth-porta-linha');
            var ja = String($(this).data('ja') || '');

            // Cliente que já está em outra porta só muda de lugar se o usuário confirmar —
            // o servidor recusaria com FTTH-TOP-012 e a tela ficaria sem explicação.
            if (ja && !confirm($(this).data('login') + ' já está em ' + ja
                             + '.\n\nMover para esta porta?')) {
                return;
            }
            vincularCliente(parseInt($linha.data('splitter'), 10),
                            parseInt($linha.data('numero'), 10),
                            parseInt($(this).data('id'), 10), !!ja);
        });

        $(document).on('click', '.js-desvincular', function () {
            desvincularCliente(parseInt($(this).data('cliente'), 10), String($(this).data('login')));
        });
        $(document).on('click', '.js-desvincular-instalacao', function () {
            var $b = $(this), id = Number($b.data('instalacao')), cfg = window.FTTH_MAPA || {};
            if (!confirm('Tirar a instalação ' + String($b.data('login')) + ' · '
                + String($b.closest('.ftth-porta-linha').find('.ftth-porta-ponto').text()).replace(/^ · /, '')
                + ' desta porta?')) return;
            FTTH.chamar({
                url: 'mapa.php?ajax=instalacao_desvincular', method: 'POST',
                data: { csrf: cfg.csrf, id: id, cliente: Number($b.data('cliente')) },
                onOk: function () { abrirClientes(caixaClientes); atualizarFichaAberta(); carregar(); },
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });

        $('#ftth-rota-pontos').on('click', '.js-ftth-rota-focar', function () {
            focarVerticeRotaMover(parseInt($(this).attr('data-indice'), 10));
        });
        $('#ftth-rota-fechar').on('click', fecharPainelRotaMover);
        $('#ftth-rota-pontos').on('click', '.js-ftth-rota-remover', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var caminho = linhaAtivaMover && linhaAtivaMover.getPath();
            var indice = parseInt($(this).attr('data-indice'), 10);
            if (modo !== 'mover' || !caminho || isNaN(indice)
                || indice <= 0 || indice >= caminho.getLength() - 1) {
                FTTH.toast('erro', 'Só é possível remover pontos intermediários da rota.');
                return;
            }
            caminho.removeAt(indice);
        });
        $('#ftth-rota-extremos-lista').on('click', '.js-ftth-rota-soltar-ponta', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if ($(this).prop('disabled')) return;
            soltarPontaPainelMover(String($(this).attr('data-lado') || ''));
        });

        $('#mover-concluir').on('click', concluirMover);
        $('#mover-ponta-soltar').on('click', function () { alterarPontaMover(null); });
        $('#mover-vinculo-abrir').on('click', function () {
            var rota = (ultimoDesenho && ultimoDesenho.vaos || []).filter(function (v) {
                return Number(v.id) === Number(vaoAtivoMoverId);
            })[0];
            if (!rota || modo !== 'mover') {
                FTTH.toast('info', 'Clique num cabo para selecioná-lo antes de vincular uma CTO no trecho.');
                return;
            }
            iniciarVinculoMeioMover(rota);
        });
        $('#mover-vinculo-cancelar').on('click', function () {
            if (vinculoMeioMover && !vinculoMeioMover.salvando) limparVinculoMeioMover();
        });
        // Cancelar é o par do Concluir: os dois encerram a edição. Sair sem gravar volta o
        // mapa ao que está no banco — por isso o aviso quando há trabalho na tela.
        $('#mover-descartar').on('click', function () {
            if (contarPendentes() > 0
                && !confirm('Descartar as alterações do mapa e sair do modo edição?')) { return; }
            sairDoModoMover();          // zera as pendências e redesenha do banco
            definirModo('navegar');     // sem pendências, não pergunta de novo
        });

        atualizarContaCamadas();

        var timerBusca = null;
        $('#busca').on('input', function () {
            var t = this.value;
            clearTimeout(timerBusca);
            timerBusca = setTimeout(function () { buscar(t); }, 250);
        });

        $(document).on('click', '.ftth-busca-item[data-lat]', function () {
            var lat = parseFloat($(this).data('lat'));
            var lng = parseFloat($(this).data('lng'));
            var id  = parseInt($(this).data('id'), 10);
            if (!isNaN(lat)) {
                mapa.setCenter({ lat: lat, lng: lng });
                mapa.setZoom(19);
            }
            $('#busca-lista').hide();
            if (id && $(this).data('tipo') === 'caixa') abrirFicha(id);
            if (id && $(this).data('tipo') === 'cliente') {
                var instalacaoId = parseInt($(this).data('instalacao'), 10) || null;
                var bloqueado = String($(this).data('bloqueado')) === '1';
                abrirClienteMapa(id, instalacaoId, {
                    tipo: String($(this).data('conta') || (instalacaoId ? 'instalacao' : 'normal')),
                    login: String($(this).data('login') || ''), bloqueado: bloqueado
                });
            }
        });

        $(document).on('click', function (e) {
            if (!$(e.target).closest('.ftth-busca').length) $('#busca-lista').hide();
        });

        $('#painel-fechar').on('click', function () { $('#painel').hide(); });

        var timerSemLocalizacao = null;
        $('#clientes-sem-localizacao-busca').on('input', function () {
            clearTimeout(timerSemLocalizacao);
            timerSemLocalizacao = setTimeout(function () { carregarClientesSemLocalizacao(true); }, 250);
        });
        $('#clientes-sem-localizacao-mais').on('click', function () { carregarClientesSemLocalizacao(false); });
        $('#lista-clientes-sem-localizacao').on('click', '.js-cliente-sem-local', function () {
            abrirClienteMapa(Number($(this).data('id')));
        });
        $('#cliente-mapa-fechar, #cliente-mapa-cancelar').on('click', function () {
            $('#modal-cliente-mapa').hide();
        });
        $('#cliente-mapa-corpo').on('click', '#im-usar-centro', function () {
            var centro = mapa && mapa.getCenter();
            if (!centro) return;
            $('#im-lat').val(centro.lat().toFixed(7));
            $('#im-lng').val(centro.lng().toFixed(7));
        });
        $('#cliente-mapa-corpo').on('click', '#im-criar', function () {
            var cfg = window.FTTH_MAPA || {};
            FTTH.chamar({
                url: 'mapa.php?ajax=instalacao_criar', method: 'POST',
                data: { csrf: cfg.csrf, cliente: clienteMapaAtual,
                    identificacao: $('#im-identificacao').val(), endereco: $('#im-endereco').val(),
                    lat: $('#im-lat').val(), lng: $('#im-lng').val(), observacao: $('#im-observacao').val() },
                onOk: function () {
                    FTTH.toast('ok', 'Instalação adicionada.');
                    carregarClientesSemLocalizacao(true);
                    carregar();
                    abrirClienteMapa(clienteMapaAtual);
                },
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });
        $('#cliente-mapa-corpo').on('click', '.js-inst-salvar', function () {
            var $f = $(this).closest('.js-inst-editar'), cfg = window.FTTH_MAPA || {};
            FTTH.chamar({
                url: 'mapa.php?ajax=instalacao_alterar', method: 'POST',
                data: { csrf: cfg.csrf, id: $f.data('id'), cliente: clienteMapaAtual,
                    identificacao: $f.find('.js-inst-identificacao').val(), endereco: $f.find('.js-inst-endereco').val(),
                    lat: $f.find('.js-inst-lat').val(), lng: $f.find('.js-inst-lng').val(),
                    observacao: $f.find('.js-inst-observacao').val() },
                onOk: function () { FTTH.toast('ok', 'Ponto atualizado.'); carregar(); abrirClienteMapa(clienteMapaAtual); },
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });
        $('#cliente-mapa-corpo').on('click', '.js-inst-excluir', function () {
            var id = Number($(this).data('id')), cfg = window.FTTH_MAPA || {};
            if (!confirm('Excluir este ponto adicional?')) return;
            FTTH.chamar({ url: 'mapa.php?ajax=instalacao_excluir', method: 'POST',
                data: { csrf: cfg.csrf, id: id, cliente: clienteMapaAtual },
                onOk: function () { FTTH.toast('ok', 'Ponto excluído.'); carregar(); abrirClienteMapa(clienteMapaAtual); },
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });
        $('#cliente-mapa-corpo').on('click', '.js-inst-desvincular', function () {
            var id = Number($(this).data('id')), cfg = window.FTTH_MAPA || {};
            if (!confirm('Desvincular esta instalação da CTO?')) return;
            FTTH.chamar({ url: 'mapa.php?ajax=instalacao_desvincular', method: 'POST',
                data: { csrf: cfg.csrf, id: id, cliente: clienteMapaAtual },
                onOk: function () { FTTH.toast('ok', 'Instalação desvinculada.'); carregar(); abrirClienteMapa(clienteMapaAtual); },
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });
        $('#cliente-mapa-corpo').on('click', '.js-cliente-desvincular', function () {
            var cfg = window.FTTH_MAPA || {};
            if (!confirm('Desvincular a instalação principal da CTO?')) return;
            FTTH.chamar({ url: 'mapa.php?ajax=desvincular_cliente', method: 'POST',
                data: { csrf: cfg.csrf, cliente: clienteMapaAtual },
                onOk: function () { FTTH.toast('ok', 'Instalação principal desvinculada.'); carregar(); abrirClienteMapa(clienteMapaAtual); },
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });
        $('#cliente-mapa-corpo').on('click', '.js-inst-vinculo-abrir', function () {
            var id = Number($(this).data('inst')) || 0;
            var $form = $('#cliente-mapa-corpo').find('.js-form-vinculo[data-inst="' + id + '"]');
            $form.toggle();
            if ($form.is(':visible')) $form.find('.js-cto-busca').trigger('focus');
        });
        $('#cliente-mapa-corpo').on('input', '.js-cto-busca', function () {
            var campo = this, $campo = $(campo), $form = $campo.closest('.js-form-vinculo');
            clearTimeout(campo._ftthBusca);
            campo._ftthBusca = setTimeout(function () {
                var q = $.trim($campo.val());
                if (q.length < 2) { $form.find('.js-cto-resultados').empty(); return; }
                FTTH.chamar({
                    url: 'mapa.php?ajax=ctos_buscar&regiao=' + regiao + '&q=' + encodeURIComponent(q),
                    onOk: function (d) {
                        var html = (d.ctos || []).map(function (c) {
                            return '<button type="button" class="ftth-cto-opcao js-cto-escolher" data-id="' + Number(c.id)
                                + '" data-nome="' + esc(c.nome) + '">' + esc(c.nome) + ' <small>' + esc(c.tipo) + '</small></button>';
                        }).join('');
                        $form.find('.js-cto-resultados').html(html || '<span class="ftth-sub">Nenhuma CTO encontrada.</span>');
                    }, onErro: function (m) { FTTH.toast('erro', m); }
                });
            }, 250);
        });
        $('#cliente-mapa-corpo').on('click', '.js-cto-escolher', function () {
            var $opcao = $(this), $form = $opcao.closest('.js-form-vinculo');
            var caixaId = Number($opcao.data('id'));
            $form.data('caixa', caixaId).find('.js-cto-busca').val($opcao.data('nome'));
            $form.find('.js-cto-resultados').empty();
            FTTH.chamar({
                url: 'mapa.php?ajax=opcoes_cto&caixa=' + caixaId,
                onOk: function (d) {
                    var $splitter = $form.find('.js-inst-splitter');
                    $splitter.html('<option value="">Escolha um splitter</option>'
                        + (d.splitters || []).map(function (s) {
                            return '<option value="' + Number(s.id) + '">' + esc(s.nome) + ' · ' + Number(s.saidas) + ' saídas</option>';
                        }).join(''));
                    $splitter.data('portas', d.portas || []).trigger('change');
                }, onErro: function (m) { FTTH.toast('erro', m); }
            });
        });
        $('#cliente-mapa-corpo').on('change', '.js-inst-splitter', function () {
            var $select = $(this), id = Number($select.val()), portas = $select.data('portas') || [];
            var livres = portas.filter(function (p) {
                return Number(p.splitter_id) === id && !p.ocupada && !p.reserva;
            });
            var $porta = $select.closest('.js-form-vinculo').find('.js-inst-porta');
            $porta.html(livres.length ? '<option value="">Escolha a saída</option>' + livres.map(function (p) {
                return '<option value="' + Number(p.numero) + '">' + esc(p.splitter_nome) + ' · saída ' + Number(p.numero) + '</option>';
            }).join('') : '<option value="">Nenhuma saída livre neste splitter</option>');
        });
        $('#cliente-mapa-corpo').on('click', '.js-inst-vincular', function () {
            var $form = $(this).closest('.js-form-vinculo');
            var splitter = Number($form.find('.js-inst-splitter').val());
            var numero = Number($form.find('.js-inst-porta').val());
            if (!splitter || !numero) { FTTH.toast('info', 'Escolha uma CTO, splitter e saída livre.'); return; }
            var cfg = window.FTTH_MAPA || {}, id = Number($form.data('inst')) || 0;
            FTTH.chamar({
                url: id ? 'mapa.php?ajax=instalacao_vincular' : 'mapa.php?ajax=vincular_cliente',
                method: 'POST',
                data: id
                    ? { csrf: cfg.csrf, id: id, cliente: clienteMapaAtual, splitter: splitter, numero: numero }
                    : { csrf: cfg.csrf, cliente: clienteMapaAtual, splitter: splitter, numero: numero, mover: '1' },
                onOk: function () { FTTH.toast('ok', 'Vínculo da instalação atualizado.'); carregar(); abrirClienteMapa(clienteMapaAtual); },
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });

        $(document).on('click', '#fc-excluir', function () {
            excluirCaixa(parseInt($(this).data('id'), 10),
                         parseInt($(this).data('versao'), 10),
                         String($(this).data('nome')));
        });
        $(document).on('click', '#fc-centralizar', function () {
            mapa.setCenter({ lat: parseFloat($(this).data('lat')), lng: parseFloat($(this).data('lng')) });
            mapa.setZoom(20);
        });
        $(document).on('click', '#fc-copiar', function () {
            var texto = $('#fc-coord').text();
            var $b = $(this);
            if (navigator.clipboard) {
                navigator.clipboard.writeText(texto).then(function () { $b.text('copiado'); });
            } else {
                window.prompt('Copie a coordenada:', texto);
            }
        });
        $(document).on('click', '#fc-editar', function () {
            var id = parseInt($(this).data('id'), 10);
            FTTH.chamar({
                url: 'mapa.php?ajax=ficha&id=' + id,
                onOk: abrirModalEdicao,
                // Recado de erro vai para o toast: a ficha pode fechar, o toast fica.
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });
        // Ponta livre vira ponto pela edição de sempre: é o mesmo registro, com o tipo e o
        // nome que o usuário der — e os cabos continuam presos nele.
        $(document).on('click', '#fp-virar', function () {
            var id = parseInt($(this).data('id'), 10);
            FTTH.chamar({
                url: 'mapa.php?ajax=ficha&id=' + id,
                onOk: function (c) {
                    abrirModalEdicao(c);
                    editando.virar = true;
                    $('#modal-titulo').text('Transformar em ponto');
                    corEscolhida = null;
                    $('.ftth-cor').removeClass('ativo').first().addClass('ativo');
                    $('#nc-saida').empty();
                    sugerirNome('');
                },
                onErro: function (m) { FTTH.toast('erro', m); }
            });
        });
        // Continuar é o MESMO cabo: sem popup de configuração — capacidade, cores e nome são
        // os dele (o servidor também impõe isso, via continuar_de).
        $(document).on('click', '#fp-continuar', function () {
            var $b = $(this);
            caboDesde = { tipo: 'CAIXA', id: parseInt($b.data('id'), 10), nome: 'ponta livre',
                          lat: parseFloat($b.data('lat')), lng: parseFloat($b.data('lng')) };
            continuando = { ponta: caboDesde.id, nome: String($b.data('nome')),
                            tipo: String($b.data('tipo')), cor: String($b.data('cor')) || '#00E676' };
            $('#painel').hide();
            definirModo('cabo');
        });

        $(document).on('click', '#q-importar', function () {
            decidirQuarentena(parseInt($(this).data('id'), 10), 'importar');
        });
        $(document).on('click', '#q-descartar', function () {
            if (!confirm('Descartar este item? Ele não entra na rede.')) return;
            decidirQuarentena(parseInt($(this).data('id'), 10), 'descartar');
        });

        window.FTTH_MAPA_API = api;
        $(document).trigger('ftth:mapa-pronto');
    };

    /* ------------------------------------------------------------ primeiros passos
     *
     * O que o assistente (js/onboarding.js) pode pedir ao mapa. Ele nunca mexe no estado daqui
     * por dentro: pede por estas funções e escuta o 'ftth:mudou'.
     */
    function irParaRegiao(id) {
        id = parseInt(id, 10) || 0;
        if (id && id !== regiao && acharRegiao(id)) trocarRegiao(id);
    }

    function enquadrarPontos(lista) {
        if (!mapa || !lista.length) return;
        var b = new google.maps.LatLngBounds();
        lista.forEach(function (p) { b.extend({ lat: p.lat, lng: p.lng }); });
        mapa.fitBounds(b, 90);
        google.maps.event.addListenerOnce(mapa, 'idle', function () {
            if (mapa.getZoom() > ZOOM_MAX_ENQUADRAR) mapa.setZoom(ZOOM_MAX_ENQUADRAR);
        });
    }

    var api = {
        regiao: function () { return regiao; },
        modo: function () { return modo; },
        mapa: function () { return mapa; },
        abrirFicha: abrirFicha,
        irParaRegiao: irParaRegiao,
        aoClicarMapa: function (callback) { callbackPontoViabilidade = callback; },
        posicionando: function () { return nomeNovaRegiao !== null; },
        desenhando: function () { return desenhandoCabo(); },

        /** O estado novo dos passos chegou: as travas acompanham. */
        atualizarPassos: function (p) {
            travas = { pop: !!p.feitos.pop };
            aplicarTravas();
        },

        /** Passo 2: devolve o motivo da recusa, ou '' e entra no posicionamento. */
        novaRegiao: function (nome) {
            var recusa = recusaNomeRegiao(nome, null);
            if (!recusa) iniciarPosicionamento(nome);
            return recusa;
        },

        /** Passos 3 e 4: modo Ponto já com o tipo (e o nome, se vier) escolhidos. */
        novoPonto: function (tipo, nome, regiaoId) {
            irParaRegiao(regiaoId);
            presetPonto = { tipo: tipo, nome: nome || '' };
            definirModo('caixa');
            selecionarTipo(tipo);
        },

        /** Passo 5: o traçado sai de `desde` e o destino pula até o cabo chegar nele. */
        novoCabo: function (desde, ate) {
            irParaRegiao(desde.regiao_id);
            definirModo('navegar');
            if (modo !== 'navegar') return;
            caboDesde = { tipo: 'CAIXA', id: desde.id, nome: desde.nome, lat: desde.lat, lng: desde.lng };
            pontoEmDestaque = ate ? ate.id : 0;
            enquadrarPontos(ate ? [desde, ate] : [desde]);
            definirModo('cabo');
            if (ultimoDesenho) desenhar(ultimoDesenho);
        },

        /** "Voltar" do balão: larga o que estava fazendo, sem gravar nada. */
        cancelar: function () {
            if (nomeNovaRegiao !== null) encerrarPosicionamento();
            definirModo('navegar');
        }
    };
    /* ---------------------------------------------------------------- emendar no cabo
     *
     * O cabo quase sempre é lançado antes das caixas serem documentadas, e num rompimento
     * entram duas caixas de emenda no meio de um vão que já existe. Em vez de apagar e
     * redesenhar o cabo, o técnico marca a caixa em cima dele e o mapa oferece a emenda.
     *
     * Oferece, não faz: uma caixa pode cair perto do cabo sem ter nada a ver com ele — um
     * poste na mesma calçada, por exemplo. Quem sabe é quem está em campo.
     *
     * A pergunta aparece em dois momentos, e a diferença entre eles é de propósito:
     *
     *   ao CLICAR para criar   a decisão é sobre o ponto, e vem antes do cadastro: quem
     *                          clicou em cima do cabo já sabe o que quer, e escolher o tipo
     *                          da caixa depois é o passo natural. A emenda é aplicada assim
     *                          que a caixa nasce.
     *   ao MOVER uma caixa     só dá para perguntar depois de gravar, porque o lote de
     *                          movimentos é uma transação só.
     */
    var emendaAtiva = null;      // o que o botão "Emendar" desta vez deve fazer
    var emendaDesejada = null;   // vão escolhido no clique, aplicado quando a caixa nascer

    /** Pergunta ao servidor se este ponto cai sobre algum cabo. */
    function consultarVaoSobPonto(lat, lng, caixaId, aoResponder) {
        FTTH.chamar({
            url: 'mapa.php?ajax=vao_sob_ponto&regiao=' + regiao
                 + '&lat=' + lat + '&lng=' + lng
                 + (caixaId ? '&caixa=' + caixaId : ''),
            onOk: function (d) { aoResponder(d && d.vao ? d : null); },
            // Não achar o cabo nunca pode atrapalhar quem só queria marcar uma caixa.
            onErro: function () { aoResponder(null); }
        });
    }

    /** Contexto altera o título e a explicação sem mudar as outras perguntas deste modal. */
    function abrirModalEmenda(texto, rotuloSim, rotuloNao, aoSim, aoNao, contexto) {
        var tipo = contexto === 'meio' ? 'meio' : (contexto ? 'ancora' : 'emenda');
        emendaAtiva = { aoSim: aoSim, aoNao: aoNao };
        $('#em-titulo').html(tipo === 'ancora'
            ? '<i class="bi-link-45deg"></i> Ancorar o cabo?'
            : (tipo === 'meio'
                ? '<i class="bi-link-45deg"></i> Conectar no meio do cabo?'
                : '<i class="bi-scissors"></i> Emendar no cabo?'));
        $('#em-explica-ancora').toggle(tipo === 'ancora');
        $('#em-explica-meio').toggle(tipo === 'meio');
        $('#em-explica-emenda').toggle(tipo === 'emenda');
        $('#em-texto').html(texto);
        $('#em-sim').text(rotuloSim).prop('disabled', false);
        $('#em-nao').text(rotuloNao).prop('disabled', false);
        $('#em-saida').empty();
        $('#modal-emenda').show();
    }

    function fecharModalEmenda() {
        emendaAtiva = null;
        $('#modal-emenda').hide();
    }

    function textoDoCabo(d) {
        return 'a <strong>' + Number(d.distancia_m).toFixed(1).replace('.', ',')
             + ' m</strong> do cabo <strong>' + esc(d.cabo_nome || 'sem nome')
             + '</strong> (' + esc(d.cabo_tipo) + ')';
    }

    /**
     * Modo Caixa: o clique caiu sobre um cabo? Pergunta antes de abrir o cadastro e guarda a
     * resposta; o cadastro segue igual, e a emenda acontece logo depois de a caixa nascer.
     */
    function perguntarEmendaNoClique(latLng, aoTerminar) {
        emendaDesejada = null;
        consultarVaoSobPonto(latLng.lat(), latLng.lng(), null, function (d) {
            if (!d) { aoTerminar(); return; }
            abrirModalEmenda(
                'Você clicou ' + textoDoCabo(d) + '. Quer emendar o cabo na caixa que vai criar aqui?',
                'Emendar no cabo', 'Só criar a caixa',
                function () {
                    emendaDesejada = { vao: d.vao, fibras: d.fibras };
                    fecharModalEmenda();
                    aoTerminar();
                },
                function () { fecharModalEmenda(); aoTerminar(); }
            );
        });
    }

    /** Quebra o vão de verdade. O servidor é quem decide se dá: aqui só mostramos o resultado. */
    function aplicarEmenda(vaoId, caixaId, aoTerminar) {
        var cfg = window.FTTH_MAPA || {};
        $('#em-sim, #em-nao').prop('disabled', true);
        FTTH.chamar({
            url: 'mapa.php?ajax=quebrar_vao',
            method: 'POST',
            data: { csrf: cfg.csrf, vao: vaoId, caixa: caixaId },
            onOk: function (d) {
                fecharModalEmenda();
                carregar();
                FTTH.toast('ok', 'Cabo emendado: dois trechos de '
                    + Math.round(d.metros_a) + ' m e ' + Math.round(d.metros_b) + ' m, com '
                    + d.fibras_passando + ' fibra(s) passando pela caixa.');
                if (aoTerminar) aoTerminar();
            },
            onErro: function (m) {
                // Com o modal aberto, o erro fica onde o usuário está olhando; sem ele
                // (emenda automática depois do cadastro), vai para o toast.
                if ($('#modal-emenda').is(':visible')) {
                    $('#em-saida').html('<div class="ftth-aviso ftth-aviso--erro">' + esc(m) + '</div>');
                    $('#em-sim, #em-nao').prop('disabled', false);
                } else {
                    FTTH.toast('erro', 'A caixa foi criada, mas não deu para emendar o cabo: ' + m);
                    if (aoTerminar) aoTerminar();
                }
            }
        });
    }

    $('#em-fechar').on('click', function () {
        var fn = emendaAtiva && emendaAtiva.aoNao;
        fecharModalEmenda();
        if (fn) fn();
    });
    $('#em-nao').on('click', function () { if (emendaAtiva) emendaAtiva.aoNao(); });
    $('#em-sim').on('click', function () { if (emendaAtiva) emendaAtiva.aoSim(); });

})();
