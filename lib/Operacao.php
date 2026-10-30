<?php
require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/Capacidade.php';
require_once __DIR__ . '/Potencia.php';
require_once __DIR__ . '/Geo.php';

/** Consultas de capacidade e qualidade da documentação, sem alterar a planta. */
final class Operacao
{
    private static function planta(): array
    {
        $caixas = Db::todos(
            'SELECT c.id, c.nome, c.tipo, c.lat, c.lng, c.regiao_id, r.nome AS regiao_nome
               FROM tab_ftth_caixa c JOIN tab_ftth_regiao r ON r.id = c.regiao_id
              WHERE c.excluido_em IS NULL AND c.tipo IN ("CTO", "CTO_AP")
              ORDER BY r.nome, c.nome');
        if (!$caixas) return [$caixas, [], [], []];
        $ids = array_map('intval', array_column($caixas, 'id'));
        $in = implode(',', array_fill(0, count($ids), '?'));
        $splitters = Db::todos(
            'SELECT id, caixa_id, nome, saidas FROM tab_ftth_splitter
              WHERE excluido_em IS NULL AND funcao = "ATENDIMENTO" AND caixa_id IN (' . $in . ')
              ORDER BY caixa_id, nome', $ids);
        if (!$splitters) return [$caixas, [], [], []];
        $spIds = array_map('intval', array_column($splitters, 'id'));
        $inSp = implode(',', array_fill(0, count($spIds), '?'));
        $ocupacoes = Db::todos(
            'SELECT splitter_id, numero, cliente_id, login, NULL AS instalacao_id
               FROM tab_ftth_porta WHERE splitter_id IN (' . $inSp . ')
             UNION ALL
             SELECT splitter_id, numero, cliente_id, login, instalacao_id
               FROM tab_ftth_instalacao_porta WHERE splitter_id IN (' . $inSp . ')
             UNION ALL
             SELECT elemento_id AS splitter_id, numero, NULL AS cliente_id, NULL AS login,
                    NULL AS instalacao_id
               FROM tab_ftth_ligacao_ponta
              WHERE elemento = "SPLITTER_OUT" AND elemento_id IN (' . $inSp . ')',
            array_merge($spIds, $spIds, $spIds));
        $reservas = [];
        if (Db::tabelaExiste('tab_ftth_reserva_porta')) {
            $reservas = Db::todos(
                'SELECT id, splitter_id, numero, cliente_id, referencia, reservado_por, expira_em
                   FROM tab_ftth_reserva_porta WHERE expira_em > NOW() AND splitter_id IN (' . $inSp . ')', $spIds);
            foreach ($reservas as &$r) $r['ativa'] = true;
            unset($r);
        }
        return [$caixas, $splitters, $ocupacoes, $reservas];
    }

    /** Contagem por região, fonte documentada (OLT/PON) e CTO. */
    public static function capacidade(): array
    {
        list($caixas, $splitters, $ocupacoes, $reservas) = self::planta();
        $porCaixa = $spPorId = [];
        foreach ($splitters as $s) {
            $s['id'] = (int) $s['id']; $s['caixa_id'] = (int) $s['caixa_id']; $s['saidas'] = (int) $s['saidas'];
            $porCaixa[$s['caixa_id']][] = $s; $spPorId[$s['id']] = $s['caixa_id'];
        }
        $ocCaixa = $resCaixa = [];
        foreach ($ocupacoes as $p) $ocCaixa[$spPorId[(int) $p['splitter_id']]][] = $p;
        foreach ($reservas as $p) {
            $p['ativa'] = true;
            $resCaixa[$spPorId[(int) $p['splitter_id']]][] = $p;
        }
        $origens = Potencia::origensPorSplitter();
        $fibrasPorCaixa = [];
        $ctoIds = array_map('intval', array_column($caixas, 'id'));
        if ($ctoIds) {
            $inCto = implode(',', array_fill(0, count($ctoIds), '?'));
            foreach (Db::todos(
                'SELECT caixa_id, elemento_id, numero FROM tab_ftth_ligacao_ponta
                  WHERE elemento = "VAO_FIBRA" AND caixa_id IN (' . $inCto . ')', $ctoIds) as $p) {
                $fibrasPorCaixa[(int) $p['caixa_id']][(int) $p['elemento_id'] . ':' . (int) $p['numero']] = true;
            }
        }
        $linhas = $resumo = [];
        foreach ($caixas as $c) {
            $id = (int) $c['id'];
            $sps = $porCaixa[$id] ?? [];
            if (!$sps) {
                $linhas[] = ['regiao' => $c['regiao_nome'], 'olt' => '—', 'pon' => '—',
                    'cto' => $c['nome'], 'caixa_id' => $id, 'regiao_id' => (int) $c['regiao_id'],
                    'capacidade_documentada' => false, 'total' => 0, 'ocupadas' => 0,
                    'reservadas' => 0, 'livres' => 0, 'fibras_conectadas' => count($fibrasPorCaixa[$id] ?? [])];
                continue;
            }
            $grupos = [];
            foreach ($sps as $s) {
                $o = $origens[(int) $s['id']] ?? null;
                $olt = $o && !empty($o['olt']) ? (string) $o['olt'] : 'Origem não identificada';
                $pon = $o && !empty($o['pon']) ? (string) $o['pon'] : 'PON não identificada';
                $key = $olt . "\0" . $pon;
                $grupos[$key]['olt'] = $olt; $grupos[$key]['pon'] = $pon;
                $grupos[$key]['splitters'][] = $s;
            }
            foreach ($grupos as $g) {
                $idsS = array_map('intval', array_column($g['splitters'], 'id'));
                $oc = array_values(array_filter($ocCaixa[$id] ?? [], static function ($p) use ($idsS) {
                    return in_array((int) $p['splitter_id'], $idsS, true);
                }));
                $res = array_values(array_filter($resCaixa[$id] ?? [], static function ($p) use ($idsS) {
                    return in_array((int) $p['splitter_id'], $idsS, true);
                }));
                $cap = Capacidade::resumir($g['splitters'], $oc, $res);
                $linhas[] = ['regiao' => $c['regiao_nome'], 'olt' => $g['olt'], 'pon' => $g['pon'],
                    'cto' => $c['nome'], 'caixa_id' => $id, 'regiao_id' => (int) $c['regiao_id'],
                    'capacidade_documentada' => true, 'total' => $cap['total'], 'ocupadas' => $cap['ocupadas'],
                    'reservadas' => $cap['reservadas'], 'livres' => $cap['livres'],
                    'splitters' => $cap['splitters'], 'lat' => (float) $c['lat'], 'lng' => (float) $c['lng'],
                    'fibras_conectadas' => count($fibrasPorCaixa[$id] ?? [])];
            }
        }

        $regioes = [];
        foreach ($linhas as $l) {
            $r = $l['regiao'];
            if (!isset($regioes[$r])) $regioes[$r] = ['regiao' => $r, 'total' => 0, 'ocupadas' => 0,
                'reservadas' => 0, 'livres' => 0, 'ctos' => 0];
            foreach (['total', 'ocupadas', 'reservadas', 'livres'] as $k) $regioes[$r][$k] += $l[$k];
            if ($l['capacidade_documentada']) $regioes[$r]['ctos']++;
        }
        return ['linhas' => $linhas, 'regioes' => array_values($regioes),
            'gerado_em' => date('Y-m-d H:i:s'), 'aviso' => 'Portas livres são saídas documentadas de splitters de atendimento; origem OLT/PON só aparece quando há caminho óptico cadastrado.'];
    }

    /** Lista de inconsistências verificáveis e limitações explícitas de cobertura. */
    public static function pendencias(): array
    {
        $itens = [];
        $semVinculo = Db::todos(
            'SELECT c.id, c.login, c.nome, c.caixa_herm, c.porta_splitter
               FROM sis_cliente c
              WHERE c.cli_ativado = "s" AND TRIM(COALESCE(c.caixa_herm, "")) <> ""
                AND NOT EXISTS (SELECT 1 FROM tab_ftth_porta p WHERE p.cliente_id = c.id)
                AND NOT EXISTS (SELECT 1 FROM tab_ftth_instalacao_porta ip WHERE ip.cliente_id = c.id)
              ORDER BY c.login LIMIT 100');
        foreach ($semVinculo as $c) $itens[] = ['tipo' => 'nativo_sem_vinculo', 'gravidade' => 'aviso',
            'titulo' => 'Cadastro nativo de CTO sem vínculo no FTTH Doc',
            'detalhe' => $c['login'] . ' · ' . $c['caixa_herm'] . ' · porta ' . ($c['porta_splitter'] ?: 'não informada'),
            'cliente_id' => (int) $c['id']];

        $divergencias = Db::todos(
            'SELECT c.id, c.login, c.caixa_herm, c.porta_splitter, cx.nome AS cto,
                    s.nome AS splitter, p.numero
               FROM tab_ftth_porta p JOIN tab_ftth_splitter s ON s.id = p.splitter_id
               JOIN tab_ftth_caixa cx ON cx.id = s.caixa_id
               JOIN sis_cliente c ON c.id = p.cliente_id
              WHERE c.cli_ativado = "s" AND (
                (TRIM(COALESCE(c.caixa_herm, "")) <> "" AND TRIM(c.caixa_herm) <> TRIM(cx.nome))
                OR (TRIM(COALESCE(c.porta_splitter, "")) <> "" AND TRIM(c.porta_splitter) <> CAST(p.numero AS CHAR)
                    AND TRIM(c.porta_splitter) <> CONCAT(s.nome, ":", p.numero)
                    AND TRIM(c.porta_splitter) <> CONCAT("Splitter ", s.nome, ":", p.numero))
              ) ORDER BY c.login LIMIT 100');
        foreach ($divergencias as $c) $itens[] = ['tipo' => 'vinculo_divergente', 'gravidade' => 'alerta',
            'titulo' => 'Vínculo FTTH e cadastro nativo divergentes',
            'detalhe' => $c['login'] . ' · FTTH: ' . $c['cto'] . ' / ' . $c['splitter'] . ':' . $c['numero']
                . ' · MK-AUTH: ' . trim($c['caixa_herm'] . ' ' . $c['porta_splitter']),
            'cliente_id' => (int) $c['id']];

        $instalacoes = Db::todos(
            'SELECT i.id, i.identificacao, i.endereco, c.login, i.cliente_id
               FROM tab_ftth_instalacao i JOIN sis_cliente c ON c.id = i.cliente_id
              LEFT JOIN tab_ftth_instalacao_porta ip ON ip.instalacao_id = i.id
              WHERE c.cli_ativado = "s" AND ip.id IS NULL ORDER BY c.login, i.id LIMIT 100');
        foreach ($instalacoes as $i) $itens[] = ['tipo' => 'instalacao_sem_porta', 'gravidade' => 'aviso',
            'titulo' => 'Ponto adicional sem porta de splitter vinculada',
            'detalhe' => $i['login'] . ' · ' . $i['identificacao'] . ($i['endereco'] ? ' · ' . $i['endereco'] : ''),
            'cliente_id' => (int) $i['cliente_id'], 'instalacao_id' => (int) $i['id']];

        if (Db::tabelaExiste('tab_ftth_reserva_porta')) {
            $conflitos = Db::todos(
                'SELECT r.id, r.numero, r.referencia, s.nome AS splitter, c.id AS caixa_id,
                        c.nome AS caixa, COALESCE(p.login, ip.login) AS login
                   FROM tab_ftth_reserva_porta r
                   JOIN tab_ftth_splitter s ON s.id = r.splitter_id
                   JOIN tab_ftth_caixa c ON c.id = s.caixa_id
                   LEFT JOIN tab_ftth_porta p ON p.splitter_id = r.splitter_id AND p.numero = r.numero
                   LEFT JOIN tab_ftth_instalacao_porta ip ON ip.splitter_id = r.splitter_id AND ip.numero = r.numero
                  WHERE r.expira_em > NOW() AND (p.id IS NOT NULL OR ip.id IS NOT NULL)
                  ORDER BY c.nome, s.nome, r.numero LIMIT 100');
            foreach ($conflitos as $r) $itens[] = ['tipo' => 'reserva_ocupada', 'gravidade' => 'alerta',
                'titulo' => 'Saída ocupada e ainda reservada',
                'detalhe' => $r['caixa'] . ' · ' . $r['splitter'] . ':' . $r['numero']
                    . ' · ' . ($r['login'] ?: 'cliente não identificado')
                    . ($r['referencia'] ? ' · reserva: ' . $r['referencia'] : ''),
                'caixa_id' => (int) $r['caixa_id']];
        }

        $vaos = Db::todos(
            'SELECT v.id, v.vertices, v.comprimento_geo, v.fator_folga, v.reserva_m,
                    v.comprimento_optico, cb.nome AS cabo, c1.nome AS inicio, c2.nome AS fim
               FROM tab_ftth_cabo_vao v JOIN tab_ftth_cabo cb ON cb.id = v.cabo_id
               JOIN tab_ftth_caixa c1 ON c1.id = v.caixa_ini_id JOIN tab_ftth_caixa c2 ON c2.id = v.caixa_fim_id
              WHERE v.excluido_em IS NULL ORDER BY v.id LIMIT 5001');
        $avaliados = 0;
        foreach ($vaos as $v) {
            $vertices = json_decode((string) $v['vertices'], true) ?: [];
            $geoCalc = count($vertices) >= 2 ? Geo::comprimento($vertices) : 0;
            $geoSalvo = (float) $v['comprimento_geo'];
            $esperadoOptico = Geo::comprimentoOptico($geoSalvo, (float) $v['fator_folga'], (float) $v['reserva_m']);
            $problemas = [];
            if (count($vertices) < 2) $problemas[] = 'geometria ausente';
            elseif ($geoSalvo <= 0) $problemas[] = 'comprimento geográfico zerado';
            elseif (abs($geoCalc - $geoSalvo) > max(15, $geoSalvo * 0.10)) {
                $problemas[] = 'rota e comprimento geográfico divergem em ' . round(abs($geoCalc - $geoSalvo)) . ' m';
            }
            if ((float) $v['comprimento_optico'] <= 0) $problemas[] = 'comprimento óptico zerado';
            elseif ($esperadoOptico > 0 && abs($esperadoOptico - (float) $v['comprimento_optico'])
                > max(20, $esperadoOptico * 0.10)) $problemas[] = 'comprimento óptico difere de fator de folga + reserva';
            if ($problemas) $itens[] = ['tipo' => 'vao_inconsistente', 'gravidade' => 'aviso',
                'titulo' => 'Revisar documentação do cabo',
                'detalhe' => $v['cabo'] . ' · ' . $v['inicio'] . ' → ' . $v['fim'] . ' · ' . implode('; ', $problemas),
                'vao_id' => (int) $v['id']];
            $avaliados++;
            if ($avaliados >= 5000) break;
        }

        $origens = Potencia::origensPorSplitter();
        $semOrigem = Db::todos(
            'SELECT c.id, c.nome, r.nome AS regiao, s.id AS splitter_id, s.nome AS splitter
               FROM tab_ftth_splitter s JOIN tab_ftth_caixa c ON c.id = s.caixa_id
               JOIN tab_ftth_regiao r ON r.id = c.regiao_id
              WHERE s.excluido_em IS NULL AND s.funcao = "ATENDIMENTO"
                AND c.excluido_em IS NULL AND c.tipo IN ("CTO","CTO_AP")
              ORDER BY r.nome,c.nome,s.nome');
        foreach ($semOrigem as $s) {
            if (isset($origens[(int) $s['splitter_id']])) continue;
            $itens[] = ['tipo' => 'sem_origem_dio', 'gravidade' => 'aviso',
                'titulo' => 'Sem caminho óptico documentado até DIO/OLT',
                'detalhe' => $s['regiao'] . ' · ' . $s['nome'] . ' · ' . $s['splitter'],
                'caixa_id' => (int) $s['id']];
        }
        return ['itens' => $itens, 'quantidade' => count($itens), 'vaos_avaliados' => min($avaliados, 5000),
            'parcial' => count($vaos) > 5000,
            'aviso' => 'São verificações da documentação cadastrada. Uma ausência pode significar falta de cadastro, não defeito físico confirmado.'];
    }

    public static function vaos(): array
    {
        return Db::todos(
            'SELECT v.id, v.cabo_id, cb.nome AS cabo, t.fibras, c1.nome AS inicio, c2.nome AS fim, r.nome AS regiao
               FROM tab_ftth_cabo_vao v JOIN tab_ftth_cabo cb ON cb.id = v.cabo_id
               JOIN tab_ftth_cabo_tipo t ON t.id = cb.cabo_tipo_id
               JOIN tab_ftth_caixa c1 ON c1.id = v.caixa_ini_id JOIN tab_ftth_caixa c2 ON c2.id = v.caixa_fim_id
               JOIN tab_ftth_regiao r ON r.id = v.regiao_id
              WHERE v.excluido_em IS NULL ORDER BY r.nome, cb.nome, v.id LIMIT 2000');
    }
}
