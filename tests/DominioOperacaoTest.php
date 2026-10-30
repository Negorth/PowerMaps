<?php
require_once __DIR__ . '/../lib/GeoTools.php';
require_once __DIR__ . '/../lib/Capacidade.php';
require_once __DIR__ . '/../lib/Impacto.php';
require_once __DIR__ . '/../lib/Viabilidade.php';

function verificar($condicao, string $mensagem): void
{
    if (!$condicao) {
        fwrite(STDERR, "FALHOU: $mensagem\n");
        exit(1);
    }
}

$p = GeoTools::coordenadas('-25.4412, -49.2768');
verificar($p !== null && abs($p['lat'] + 25.4412) < 0.000001, 'lê coordenadas com sinal');
verificar(GeoTools::coordenadas('91, 0') === null, 'recusa latitude fora do globo');
verificar(GeoTools::raio(300) === 300 && GeoTools::raio(99) === null, 'limita raio comercial');
verificar(GeoTools::distanciaMetros(-25.0, -49.0, -25.0, -49.0) === 0.0, 'distância zero');
$ordenados = GeoTools::ordenarPontos([
    ['id' => 2, 'lat' => -25.01, 'lng' => -49.0],
    ['id' => 1, 'lat' => -25.001, 'lng' => -49.0],
], -25.0, -49.0, 300, 20);
verificar(count($ordenados) === 1 && $ordenados[0]['id'] === 1, 'ordena e aplica raio por distância real');

$cap = Capacidade::resumir(
    [['id' => 4, 'nome' => 'SPL.01', 'saidas' => 4]],
    [['splitter_id' => 4, 'numero' => 1], ['splitter_id' => 4, 'numero' => 1]],
    [['splitter_id' => 4, 'numero' => 2, 'ativa' => true]]
);
verificar($cap['total'] === 4 && $cap['ocupadas'] === 1 && $cap['reservadas'] === 1
    && $cap['livres'] === 2, 'não duplica ocupação principal/adicional e separa reservas');

$grafo = [
    'A' => [['para' => 'B', 'vao_id' => 10, 'fibra' => 1], ['para' => 'D', 'vao_id' => 11, 'fibra' => 1]],
    'B' => [['para' => 'C', 'vao_id' => 12, 'fibra' => 1]],
    'D' => [['para' => 'C', 'vao_id' => 13, 'fibra' => 1]],
    'C' => [],
];
verificar(isset(Impacto::alcancaveis($grafo, ['A'], null)['C']), 'topologia normal alcança destino');
verificar(isset(Impacto::alcancaveis($grafo, ['A'], ['vao_id' => 12, 'fibra' => 1])['C']),
    'rota alternativa preserva serviço na simulação');
$semAlternativa = ['A' => [['para' => 'B', 'vao_id' => 10, 'fibra' => 1]],
    'B' => [['para' => 'C', 'vao_id' => 12, 'fibra' => 1]], 'C' => []];
verificar(!isset(Impacto::alcancaveis($semAlternativa, ['A'], ['vao_id' => 12, 'fibra' => 1])['C']),
    'sem caminho alternativo o destino perde alcançabilidade');

echo "Domínio FTTH: OK\n";
