/* Busca comercial de CTOs proximas. O endereço fica no navegador; o servidor recebe só lat/lng/raio. */
(function ($) {
    'use strict';

    var api = null, marcador = null, raio = null, ponto = null, geocoder = null, previaDrop = null;
    var selecionandoMapa = false, requisicao = 0;

    function esc(v) {
        return String(v === null || v === undefined ? '' : v)
            .replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
    }

    function dizer(texto, classe) {
        $('#viab-status').removeClass('erro ok').addClass(classe || '').text(texto);
    }

    function lerRaio() {
        var n = Number($('#viab-raio').val());
        if (!isFinite(n) || n < 100 || n > 5000 || Math.floor(n) !== n) {
            dizer('O raio deve ficar entre 100 e 5000 metros.', 'erro');
            return null;
        }
        return n;
    }

    function limparPreviaDrop() {
        if (previaDrop) {
            previaDrop.setMap(null);
            previaDrop = null;
        }
    }

    function formatarMetros(metros) {
        return Number(metros).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
    }

    function desenharPreviaDrop(cto) {
        if (!api || !api.mapa() || !ponto || !cto) {
            dizer('Informe o endereço do futuro cliente antes de visualizar o trajeto.', 'erro');
            return;
        }

        var destino = { lat: Number(cto.lat), lng: Number(cto.lng) };
        var distancia = Number(cto.distancia);
        if (!isFinite(destino.lat) || !isFinite(destino.lng)
            || !isFinite(distancia) || distancia < 0) {
            dizer('Não foi possível calcular a prévia deste trajeto.', 'erro');
            return;
        }

        var mapa = api.mapa();
        var origem = { lat: Number(ponto.lat), lng: Number(ponto.lng) };
        limparPreviaDrop();

        previaDrop = new google.maps.Polyline({
            map: mapa,
            path: [origem, destino],
            geodesic: true,
            clickable: false,
            strokeOpacity: 0,
            strokeWeight: 3,
            zIndex: 1300,
            icons: [
                {
                    icon: { path: 'M 0,-1 0,1', strokeColor: '#1769E0', strokeOpacity: 1, scale: 3 },
                    offset: '0',
                    repeat: '12px'
                },
                {
                    icon: {
                        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                        fillColor: '#1769E0', fillOpacity: 1,
                        strokeColor: '#FFFFFF', strokeWeight: 1, scale: 3
                    },
                    offset: '100%'
                }
            ]
        });

        var limites = new google.maps.LatLngBounds();
        limites.extend(origem);
        limites.extend(destino);
        if (distancia < 20) {
            mapa.panTo({ lat: (origem.lat + destino.lat) / 2, lng: (origem.lng + destino.lng) / 2 });
            mapa.setZoom(Math.min(Math.max(mapa.getZoom() || 16, 18), 19));
        } else {
            var painel = document.getElementById('viabilidade-painel');
            var caixaMapa = mapa.getDiv().getBoundingClientRect();
            var caixaPainel = painel && !painel.hidden ? painel.getBoundingClientRect() : null;
            var padding = { top: 42, right: 42, bottom: 42, left: 42 };
            if (caixaPainel && caixaPainel.width && caixaPainel.height) {
                if (caixaPainel.top > caixaMapa.top + 100) {
                    padding.bottom += Math.max(0, caixaMapa.bottom - caixaPainel.top) + 16;
                } else if (caixaPainel.left > caixaMapa.left) {
                    padding.right += Math.max(0, caixaMapa.right - caixaPainel.left) + 16;
                }
            }
            mapa.fitBounds(limites, padding);
            google.maps.event.addListenerOnce(mapa, 'idle', function () {
                if (mapa.getZoom() > 19) mapa.setZoom(19);
            });
        }

        dizer('Prévia em linha reta até ' + cto.nome + ': aproximadamente '
            + formatarMetros(distancia) + ' m. O trajeto real depende da vistoria.', 'ok');
    }

    function desenharPonto(lat, lng, moverMapa) {
        if (!api || !api.mapa() || !isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            dizer('Não foi possível posicionar esse ponto.', 'erro');
            return;
        }
        limparPreviaDrop();
        ponto = { lat: Number(lat), lng: Number(lng) };
        $('#viab-coordenadas').val(ponto.lat.toFixed(6) + ', ' + ponto.lng.toFixed(6));
        if (!marcador) {
            marcador = new google.maps.Marker({ map: api.mapa(), draggable: true, title: 'Endereço candidato',
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#1769E0', fillOpacity: 1,
                    strokeColor: '#FFFFFF', strokeWeight: 3 }, zIndex: 1000 });
            marcador.addListener('dragend', function () {
                var p = marcador.getPosition();
                desenharPonto(p.lat(), p.lng(), false);
            });
        }
        marcador.setPosition(ponto);
        if (!raio) raio = new google.maps.Circle({ map: api.mapa(), clickable: false,
            strokeColor: '#1769E0', strokeOpacity: 0.8, strokeWeight: 2,
            fillColor: '#1769E0', fillOpacity: 0.10, zIndex: 1 });
        raio.setCenter(ponto);
        var metros = lerRaio();
        if (metros !== null) raio.setRadius(metros);
        if (moverMapa) {
            api.mapa().panTo(ponto);
            api.mapa().setZoom(Math.max(16, api.mapa().getZoom()));
        }
        consultar();
    }

    function formatarCapacidade(c) {
        if (!c.capacidade_documentada) return 'Capacidade não documentada (CTO sem splitter de atendimento).';
        return Number(c.portas_livres) + ' livres · ' + Number(c.portas_ocupadas) + ' ocupadas · '
            + Number(c.portas_reservadas) + ' reservadas de ' + Number(c.portas_total) + ' portas'
            + (c.splitters && c.splitters.length ? '<br>' + c.splitters.map(function (s) {
                return esc(s.nome) + ': ' + Number(s.livres) + ' livres / ' + Number(s.total);
            }).join(' · ') : '');
    }

    function consultar() {
        var metros = lerRaio();
        if (!ponto || metros === null) return;
        var atual = ++requisicao;
        $('#viab-resultados').empty();
        dizer('Procurando CTOs neste raio…');
        // O endereço digitado não é enviado nem registrado: a consulta recebe só a coordenada.
        FTTH.chamar({
            url: 'mapa.php?ajax=viabilidade&lat=' + encodeURIComponent(ponto.lat)
                + '&lng=' + encodeURIComponent(ponto.lng) + '&raio=' + encodeURIComponent(metros),
            onOk: function (d) {
                if (atual !== requisicao) return;
                var ctos = d.ctos || [];
                if (!ctos.length) {
                    dizer('Nenhuma CTO cadastrada dentro de ' + metros + ' m.', 'ok');
                    return;
                }
                dizer(ctos.length + ' CTO' + (ctos.length === 1 ? '' : 's') + ' encontrada' + (ctos.length === 1 ? '' : 's')
                    + ' · distância em linha reta.', 'ok');
                $('#viab-resultados').html(ctos.map(function (c) {
                    return '<article class="ftth-viab-cto"><div class="ftth-viab-cto-topo"><strong>'
                        + esc(c.nome) + ' <small>· ' + esc(c.regiao_nome) + '</small></strong><span class="ftth-viab-dist">'
                        + formatarMetros(c.distancia_m) + ' m · linha reta</span></div><div class="ftth-viab-capacidade">'
                        + formatarCapacidade(c) + '</div><button type="button" class="ftth-btn ftth-btn--sec js-viab-cto"'
                        + ' data-id="' + Number(c.id) + '" data-regiao="' + Number(c.regiao_id) + '"'
                        + ' data-lat="' + Number(c.lat) + '" data-lng="' + Number(c.lng) + '"'
                        + ' data-distancia="' + Number(c.distancia_m) + '" data-nome="' + esc(c.nome) + '">'
                        + '<i class="bi-signpost-2"></i> Ver possível trajeto</button></article>';
                }).join(''));
            },
            onErro: function (m) {
                if (atual === requisicao) dizer(m || 'Falha ao consultar as CTOs próximas.', 'erro');
            }
        });
    }

    function usarCoordenadas() {
        var texto = $.trim($('#viab-coordenadas').val());
        var m = /^\s*([+-]?(?:\d{1,2})(?:\.\d+)?)\s*,\s*([+-]?(?:\d{1,3})(?:\.\d+)?)\s*$/.exec(texto);
        if (!m) { dizer('Use latitude e longitude no formato -25.4412, -49.2768.', 'erro'); return; }
        var lat = Number(m[1]), lng = Number(m[2]);
        if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            dizer('Latitude ou longitude fora do intervalo válido.', 'erro'); return;
        }
        $('#viab-enderecos').empty();
        desenharPonto(lat, lng, true);
    }

    function buscarEndereco() {
        var endereco = $.trim($('#viab-endereco').val());
        if (endereco.length < 4) { dizer('Digite o endereço com pelo menos rua e cidade.', 'erro'); return; }
        if (!window.google || !google.maps || !google.maps.Geocoder) {
            dizer('Geocodificação indisponível. Use coordenadas ou marque o ponto no mapa.', 'erro'); return;
        }
        if (!geocoder) geocoder = new google.maps.Geocoder();
        $('#viab-enderecos').empty();
        dizer('Localizando endereço…');
        geocoder.geocode({ address: endereco, region: 'BR', componentRestrictions: { country: 'BR' } }, function (results, status) {
            if (status !== 'OK' || !results || !results.length) {
                dizer(status === 'REQUEST_DENIED'
                    ? 'O Google recusou a busca de endereço. Verifique se a Geocoding API está habilitada; coordenadas continuam disponíveis.'
                    : 'Endereço não localizado. Tente incluir cidade e estado ou use coordenadas.', 'erro');
                return;
            }
            $('#viab-enderecos').html(results.slice(0, 5).map(function (r, i) {
                var loc = r.geometry.location;
                return '<button type="button" class="ftth-viab-endereco js-viab-endereco" data-i="' + i
                    + '" data-lat="' + loc.lat() + '" data-lng="' + loc.lng() + '">'
                    + esc(r.formatted_address) + '</button>';
            }).join(''));
            dizer(results.length > 1 ? 'Escolha o endereço correto entre os resultados.' : 'Endereço encontrado.');
        });
    }

    function iniciar() {
        api = window.FTTH_MAPA_API;
        if (!api) return;
        api.aoClicarMapa(function (latLng) {
            if (!selecionandoMapa) return false;
            selecionandoMapa = false;
            $('#viab-escolher-mapa').removeClass('ativo').html('<i class="bi-crosshair"></i> Marcar no mapa');
            desenharPonto(latLng.lat(), latLng.lng(), false);
            return true;
        });
    }

    $(document).on('ftth:mapa-pronto', iniciar);
    $(function () {
        $('#viabilidade-abrir').on('click', function () {
            var aberto = !$('#viabilidade-painel').prop('hidden');
            $('#viabilidade-painel').prop('hidden', aberto);
            $(this).attr('aria-expanded', aberto ? 'false' : 'true');
        });
        if (String(window.location.search).indexOf('viabilidade=1') >= 0) $('#viabilidade-abrir').trigger('click');
        $('#viabilidade-fechar').on('click', function () {
            $('#viabilidade-painel').prop('hidden', true);
            $('#viabilidade-abrir').attr('aria-expanded', 'false').trigger('focus');
            selecionandoMapa = false;
        });
        $('#viab-buscar-endereco').on('click', buscarEndereco);
        $('#viab-endereco').on('keydown', function (e) { if (e.key === 'Enter') buscarEndereco(); });
        $('#viab-usar-coordenadas').on('click', usarCoordenadas);
        $('#viab-coordenadas').on('keydown', function (e) { if (e.key === 'Enter') usarCoordenadas(); });
        $('#viab-escolher-mapa').on('click', function () {
            if (!api || !api.mapa()) { dizer('O mapa ainda está carregando.', 'erro'); return; }
            if (api.modo() !== 'navegar') { dizer('Conclua a edição atual do mapa antes de marcar o endereço.', 'erro'); return; }
            selecionandoMapa = !selecionandoMapa;
            $(this).toggleClass('ativo', selecionandoMapa)
                .html(selecionandoMapa ? 'Toque no mapa…' : '<i class="bi-crosshair"></i> Marcar no mapa');
            dizer(selecionandoMapa ? 'Toque no local do futuro cliente no mapa.' : 'Seleção cancelada.');
        });
        $('#viab-raio').on('change', function () {
            var metros = lerRaio();
            if (metros !== null) {
                if (raio) raio.setRadius(metros);
                consultar();
            }
        });
        $(document).on('click', '.js-viab-endereco', function () {
            $('#viab-enderecos').empty();
            desenharPonto(Number($(this).data('lat')), Number($(this).data('lng')), true);
        });
        $(document).on('click', '.js-viab-cto', function () {
            var $b = $(this), region = Number($b.data('regiao'));
            api.irParaRegiao(region);
            desenharPreviaDrop({
                lat: Number($b.data('lat')),
                lng: Number($b.data('lng')),
                distancia: Number($b.data('distancia')),
                nome: String($b.data('nome') || 'CTO selecionada')
            });
        });
    });
}(jQuery));
