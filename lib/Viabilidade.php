<?php
require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/GeoTools.php';
require_once __DIR__ . '/Capacidade.php';

/** Consulta de proximidade para prospecção; não cria nem persiste um cliente. */
final class Viabilidade
{
    public static function buscar(float $lat, float $lng, int $raioM): array
    {
        $deltaLat = $raioM / 110574;
        $cosLat = max(0.01, abs(cos(deg2rad($lat))));
        $deltaLng = min(180, $raioM / (111320 * $cosLat));
        $ctos = Db::todos(
            'SELECT c.id, c.nome, c.tipo, c.regiao_id, r.nome AS regiao_nome, c.lat, c.lng
               FROM tab_ftth_caixa c JOIN tab_ftth_regiao r ON r.id = c.regiao_id
              WHERE c.excluido_em IS NULL AND c.tipo IN ("CTO", "CTO_AP")
                AND c.lat BETWEEN ? AND ? AND c.lng BETWEEN ? AND ?',
            [max(-90, $lat - $deltaLat), min(90, $lat + $deltaLat),
             max(-180, $lng - $deltaLng), min(180, $lng + $deltaLng)]);
        if (!$ctos) return [];

        $caixaIds = array_map('intval', array_column($ctos, 'id'));
        $in = implode(',', array_fill(0, count($caixaIds), '?'));
        $splitters = Db::todos(
            'SELECT id, caixa_id, nome, saidas FROM tab_ftth_splitter
              WHERE excluido_em IS NULL AND funcao = "ATENDIMENTO" AND caixa_id IN (' . $in . ')
              ORDER BY caixa_id, nome', $caixaIds);
        $splittersPorCaixa = [];
        $splitterIds = [];
        foreach ($splitters as $s) {
            $s['id'] = (int) $s['id'];
            $s['saidas'] = (int) $s['saidas'];
            $splitterIds[] = $s['id'];
            $splittersPorCaixa[(int) $s['caixa_id']][] = $s;
        }

        $ocupacoes = $reservas = [];
        if ($splitterIds) {
            $inS = implode(',', array_fill(0, count($splitterIds), '?'));
            $ocupacoes = Db::todos(
                'SELECT splitter_id, numero FROM tab_ftth_porta WHERE splitter_id IN (' . $inS . ')
                 UNION
                 SELECT splitter_id, numero FROM tab_ftth_instalacao_porta WHERE splitter_id IN (' . $inS . ')
                 UNION
                 SELECT elemento_id AS splitter_id, numero FROM tab_ftth_ligacao_ponta
                  WHERE elemento = "SPLITTER_OUT" AND elemento_id IN (' . $inS . ')',
                array_merge($splitterIds, $splitterIds, $splitterIds));
            if (Db::tabelaExiste('tab_ftth_reserva_porta')) {
                $reservas = Db::todos(
                    'SELECT id, splitter_id, numero, cliente_id, referencia, reservado_por, expira_em
                       FROM tab_ftth_reserva_porta
                      WHERE expira_em > NOW() AND splitter_id IN (' . $inS . ')', $splitterIds);
            }
        }

        $porCaixaOcupadas = $porCaixaReservas = [];
        $caixaPorSplitter = [];
        foreach ($splitters as $s) $caixaPorSplitter[(int) $s['id']] = (int) $s['caixa_id'];
        foreach ($ocupacoes as $p) {
            $porCaixaOcupadas[$caixaPorSplitter[(int) $p['splitter_id']]][] = $p;
        }
        foreach ($reservas as $p) {
            $p['ativa'] = true;
            $porCaixaReservas[$caixaPorSplitter[(int) $p['splitter_id']]][] = $p;
        }

        foreach ($ctos as &$c) {
            $id = (int) $c['id'];
            $grupo = Capacidade::resumir($splittersPorCaixa[$id] ?? [],
                $porCaixaOcupadas[$id] ?? [], $porCaixaReservas[$id] ?? []);
            $c['id'] = $id;
            $c['regiao_id'] = (int) $c['regiao_id'];
            $c['lat'] = (float) $c['lat'];
            $c['lng'] = (float) $c['lng'];
            $c['capacidade_documentada'] = $grupo['total'] > 0;
            $c['portas_total'] = $grupo['total'];
            $c['portas_ocupadas'] = $grupo['ocupadas'];
            $c['portas_reservadas'] = $grupo['reservadas'];
            $c['portas_livres'] = $grupo['livres'];
            $c['splitters'] = $grupo['splitters'];
        }
        unset($c);
        return GeoTools::ordenarPontos($ctos, $lat, $lng, $raioM, 20);
    }
}
