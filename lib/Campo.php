<?php
require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/Mapa.php';
require_once __DIR__ . '/Topologia.php';
require_once __DIR__ . '/Auditoria.php';
require_once __DIR__ . '/Upload.php';
require_once __DIR__ . '/Resultado.php';

/** Leituras e evidências de campo, associadas a uma CTO documentada. */
final class Campo
{
    public static function ficha(int $caixaId): ?array
    {
        $caixa = Mapa::ficha($caixaId);
        if (!$caixa || !in_array($caixa['tipo'] ?? '', ['CTO', 'CTO_AP'], true)) return null;
        $caixa['portas'] = Topologia::portas($caixaId);
        $caixa['medicoes'] = Db::todos(
            'SELECT id, splitter_id, numero, ponto, dbm, lambda_nm, observacao, medido_por, medido_em
               FROM tab_ftth_campo_medicao WHERE caixa_id = ? ORDER BY medido_em DESC, id DESC LIMIT 50', [$caixaId]);
        $caixa['fotos'] = Db::todos(
            'SELECT id, legenda, mime, bytes, enviado_por, criado_em
               FROM tab_ftth_campo_foto WHERE caixa_id = ? ORDER BY criado_em DESC, id DESC LIMIT 30', [$caixaId]);
        return $caixa;
    }

    public static function medir(int $caixaId, int $splitterId, int $numero, string $ponto,
                                 $dbm, $lambda, string $observacao, string $usuario): Resultado
    {
        $valor = filter_var($dbm, FILTER_VALIDATE_FLOAT);
        $pontos = ['DIO', 'ENTRADA_CTO', 'CTO', 'DROP', 'ONU', 'OUTRO'];
        $comprimentos = [850, 1270, 1310, 1490, 1550, 1577, 1625];
        $lambdaNm = $lambda === '' || $lambda === null ? null : (int) $lambda;
        if ($valor === false || !is_finite((float) $valor) || $valor < -100 || $valor > 30
            || !in_array($ponto, $pontos, true) || ($lambdaNm !== null && !in_array($lambdaNm, $comprimentos, true))) {
            return Resultado::erro('FTTH-SYS-002', [], 'Confira o valor em dBm, o ponto e o comprimento de onda.');
        }
        $caixa = Db::um('SELECT id, nome, tipo, regiao_id FROM tab_ftth_caixa
                          WHERE id = ? AND excluido_em IS NULL', [$caixaId]);
        if (!$caixa || !in_array($caixa['tipo'], ['CTO', 'CTO_AP'], true)) {
            return Resultado::erro('FTTH-TOP-001', ['caixa_id' => $caixaId], 'CTO não encontrada.');
        }
        if ($splitterId > 0) {
            $s = Db::um('SELECT id, caixa_id, saidas FROM tab_ftth_splitter
                          WHERE id = ? AND funcao = "ATENDIMENTO" AND excluido_em IS NULL', [$splitterId]);
            $entrada = $ponto === 'ENTRADA_CTO';
            if (!$s || (int) $s['caixa_id'] !== $caixaId
                || ($entrada ? $numero !== 0 : ($numero < 1 || $numero > (int) $s['saidas']))) {
                return Resultado::erro('FTTH-SYS-002', [], 'Splitter e saída não pertencem a essa CTO.');
            }
        } else {
            if ($ponto === 'ENTRADA_CTO') {
                return Resultado::erro('FTTH-SYS-002', [], 'Escolha o splitter cuja entrada foi medida.');
            }
            $splitterId = 0;
            $numero = 0;
        }
        return Db::transacao(function () use ($caixa, $caixaId, $splitterId, $numero, $ponto,
                                               $valor, $lambdaNm, $observacao, $usuario) {
            Db::exec(
                'INSERT INTO tab_ftth_campo_medicao
                    (caixa_id, splitter_id, numero, ponto, dbm, lambda_nm, observacao,
                     medido_por, medido_em, criado_em)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
                [$caixaId, $splitterId ?: null, $numero ?: null, $ponto, $valor, $lambdaNm,
                 trim(mb_substr($observacao, 0, 500)) ?: null, $usuario]);
            $id = Db::ultimoId();
            Auditoria::registrar('campo_medicao', $id, 'registrar', null, [
                'caixa' => $caixa['nome'], 'splitter_id' => $splitterId ?: null, 'numero' => $numero ?: null,
                'ponto' => $ponto, 'dbm' => (float) $valor, 'lambda_nm' => $lambdaNm,
                'medido_por' => $usuario,
            ], (int) $caixa['regiao_id']);
            return Resultado::ok(['id' => $id]);
        });
    }

    public static function foto(int $caixaId, array $arquivo, string $legenda, string $usuario): Resultado
    {
        $caixa = Db::um('SELECT id, nome, tipo, regiao_id FROM tab_ftth_caixa
                          WHERE id = ? AND excluido_em IS NULL', [$caixaId]);
        if (!$caixa || !in_array($caixa['tipo'], ['CTO', 'CTO_AP'], true)) {
            return Resultado::erro('FTTH-TOP-001', ['caixa_id' => $caixaId], 'CTO não encontrada.');
        }
        $dir = function_exists('ftth_dir') ? ftth_dir('campo') : null;
        if (!$dir) return Resultado::erro('FTTH-SYS-001', [], 'Pasta privada de fotos indisponível.');
        $r = Upload::receber($arquivo, ['jpg', 'jpeg', 'png', 'webp'], $dir, 8 * 1024 * 1024);
        if (empty($r['ok'])) return Resultado::erro($r['code'] ?? 'FTTH-SYS-002', [], $r['detalhe'] ?? null);
        try {
            return Db::transacao(function () use ($caixa, $caixaId, $r, $legenda, $usuario) {
                Db::exec(
                    'INSERT INTO tab_ftth_campo_foto
                        (caixa_id, caminho, mime, bytes, legenda, enviado_por, criado_em)
                     VALUES (?, ?, ?, ?, ?, ?, NOW())',
                    [$caixaId, $r['caminho'], $r['mime'], $r['bytes'],
                     trim(mb_substr($legenda, 0, 180)) ?: null, $usuario]);
                $id = Db::ultimoId();
                Auditoria::registrar('campo_foto', $id, 'enviar', null, [
                    'caixa' => $caixa['nome'], 'bytes' => $r['bytes'], 'mime' => $r['mime'],
                    'enviado_por' => $usuario,
                ], (int) $caixa['regiao_id']);
                return Resultado::ok(['id' => $id]);
            });
        } catch (Throwable $e) {
            @unlink($r['caminho']);
            throw $e;
        }
    }

    /** Caminho de foto só é liberado após autenticação e validação da pasta privada. */
    public static function caminhoFoto(int $id): ?array
    {
        $foto = Db::um('SELECT caminho, mime FROM tab_ftth_campo_foto WHERE id = ?', [$id]);
        $raiz = function_exists('ftth_dir') ? ftth_dir('campo') : null;
        if (!$foto || !$raiz) return null;
        $baseReal = realpath($raiz);
        $arquivoReal = realpath((string) $foto['caminho']);
        if (!$baseReal || !$arquivoReal || strpos($arquivoReal, $baseReal . DIRECTORY_SEPARATOR) !== 0
            || !is_file($arquivoReal)) return null;
        return ['caminho' => $arquivoReal, 'mime' => $foto['mime']];
    }
}
