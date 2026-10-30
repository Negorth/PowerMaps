<?php
require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/Auditoria.php';
require_once __DIR__ . '/Resultado.php';

/** Reservas de porta de atendimento, serializadas pelo mesmo splitter que protege os vínculos. */
final class ReservaPorta
{
    public static function listarCaixa(int $caixaId): array
    {
        if (!Db::tabelaExiste('tab_ftth_reserva_porta')) return [];
        return Db::todos(
            'SELECT r.id, r.splitter_id, r.numero, r.cliente_id, r.referencia, r.reservado_por,
                    r.expira_em, s.nome AS splitter_nome
               FROM tab_ftth_reserva_porta r
               JOIN tab_ftth_splitter s ON s.id = r.splitter_id
              WHERE s.caixa_id = ? AND r.expira_em > NOW()
              ORDER BY s.nome, r.numero', [$caixaId]);
    }

    public static function criar(int $splitterId, int $numero, ?int $clienteId, string $referencia,
                                 int $horas, string $usuario): Resultado
    {
        if (!Db::tabelaExiste('tab_ftth_reserva_porta')) {
            return Resultado::erro('FTTH-SYS-001', [], 'Atualize o schema do addon antes de reservar portas.');
        }
        if ($numero < 1 || $horas < 1 || $horas > 168) {
            return Resultado::erro('FTTH-SYS-002', [], 'Informe uma porta válida e prazo entre 1 e 168 horas.');
        }
        $referencia = trim($referencia);
        if (mb_strlen($referencia) > 120) $referencia = mb_substr($referencia, 0, 120);

        return Db::transacao(function () use ($splitterId, $numero, $clienteId, $referencia, $horas, $usuario) {
            $s = Db::um(
                'SELECT s.id, s.nome, s.funcao, s.saidas, s.excluido_em, c.id AS caixa_id,
                        c.nome AS caixa_nome, c.regiao_id, c.excluido_em AS caixa_excluido
                   FROM tab_ftth_splitter s JOIN tab_ftth_caixa c ON c.id = s.caixa_id
                  WHERE s.id = ? FOR UPDATE', [$splitterId]);
            if (!$s || $s['excluido_em'] !== null || $s['caixa_excluido'] !== null
                || $s['funcao'] !== 'ATENDIMENTO' || $numero > (int) $s['saidas']) {
                return Resultado::erro('FTTH-TOP-009', [], 'Selecione uma saída válida de um splitter de atendimento ativo.');
            }
            if ($clienteId !== null && !Db::um(
                'SELECT id FROM sis_cliente WHERE id = ? AND cli_ativado = "s"', [$clienteId])) {
                return Resultado::erro('FTTH-SYS-002', ['cliente_id' => $clienteId],
                    'O cliente associado à reserva não existe ou não está ativo.');
            }
            $ocupada = Db::um(
                'SELECT login FROM tab_ftth_porta WHERE splitter_id = ? AND numero = ?
                 UNION ALL
                 SELECT login FROM tab_ftth_instalacao_porta WHERE splitter_id = ? AND numero = ? LIMIT 1',
                [$splitterId, $numero, $splitterId, $numero]);
            if ($ocupada) {
                return Resultado::erro('FTTH-TOP-011', ['numero' => $numero, 'login' => $ocupada['login']],
                    'Essa saída já está ocupada e não pode ser reservada.');
            }
            $ligacao = Db::um(
                'SELECT ligacao_id FROM tab_ftth_ligacao_ponta
                  WHERE elemento = "SPLITTER_OUT" AND elemento_id = ? AND numero = ? LIMIT 1',
                [$splitterId, $numero]);
            if ($ligacao) {
                return Resultado::erro('FTTH-TOP-011', ['splitter' => $splitterId, 'numero' => $numero],
                    'Essa saída já alimenta um cabo ou outro splitter e não pode ser reservada.');
            }

            $atual = Db::um(
                'SELECT id, cliente_id, referencia, reservado_por, expira_em
                   FROM tab_ftth_reserva_porta WHERE splitter_id = ? AND numero = ? FOR UPDATE',
                [$splitterId, $numero]);
            $ativa = $atual && Db::um(
                'SELECT id FROM tab_ftth_reserva_porta WHERE id = ? AND expira_em > NOW()', [(int) $atual['id']]);
            if ($ativa && $atual['reservado_por'] !== $usuario) {
                return Resultado::erro('FTTH-TOP-011', ['numero' => $numero, 'expira_em' => $atual['expira_em']],
                    'Essa saída já está reservada por outro funcionário.');
            }
            $clienteAtual = (int) ($atual['cliente_id'] ?? 0);
            $clienteNovo = (int) ($clienteId ?? 0);
            if ($ativa && $atual['reservado_por'] === $usuario
                && $clienteAtual > 0 && $clienteAtual !== $clienteNovo) {
                return Resultado::erro('FTTH-TOP-011', ['numero' => $numero],
                    'A reserva ativa está associada a outro cliente; cancele-a antes de alterar.');
            }

            $antes = $ativa ? $atual : null;
            if ($atual) {
                $id = (int) $atual['id'];
                Db::exec(
                    'UPDATE tab_ftth_reserva_porta
                        SET cliente_id = ?, referencia = ?, reservado_por = ?,
                            expira_em = DATE_ADD(NOW(), INTERVAL ' . (int) $horas . ' HOUR)
                      WHERE id = ?', [$clienteId, $referencia !== '' ? $referencia : null, $usuario, $id]);
            } else {
                Db::exec(
                    'INSERT INTO tab_ftth_reserva_porta
                        (splitter_id, numero, cliente_id, referencia, reservado_por, expira_em, criado_em)
                     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ' . (int) $horas . ' HOUR), NOW())',
                    [$splitterId, $numero, $clienteId, $referencia !== '' ? $referencia : null, $usuario]);
                $id = Db::ultimoId();
            }
            $depois = ['splitter_id' => $splitterId, 'caixa' => $s['caixa_nome'], 'numero' => $numero,
                'cliente_id' => $clienteId, 'referencia' => $referencia, 'reservado_por' => $usuario,
                'prazo_horas' => $horas];
            Auditoria::registrar('reserva_porta', $id, $antes ? 'renovar' : 'reservar', $antes, $depois,
                (int) $s['regiao_id']);
            $expiraEm = Db::valor('SELECT expira_em FROM tab_ftth_reserva_porta WHERE id = ?', [$id]);
            return Resultado::ok(['id' => $id, 'expira_em' => $expiraEm,
                'caixa_nome' => $s['caixa_nome'], 'splitter_nome' => $s['nome'], 'numero' => $numero]);
        });
    }

    /** Deve ser chamada dentro da transação com a linha do splitter já bloqueada. */
    public static function autorizarUso(int $splitterId, int $numero, int $clienteId, string $usuario): ?Resultado
    {
        if (!Db::tabelaExiste('tab_ftth_reserva_porta')) return null;
        $r = Db::um(
            'SELECT id, cliente_id, referencia, reservado_por, expira_em
               FROM tab_ftth_reserva_porta WHERE splitter_id = ? AND numero = ? FOR UPDATE',
            [$splitterId, $numero]);
        if (!$r) return null;
        $ativa = Db::um('SELECT id FROM tab_ftth_reserva_porta WHERE id = ? AND expira_em > NOW()', [(int) $r['id']]);
        if (!$ativa) {
            Db::exec('DELETE FROM tab_ftth_reserva_porta WHERE id = ?', [(int) $r['id']]);
            Auditoria::registrar('reserva_porta', (int) $r['id'], 'expirar', $r, null);
            return null;
        }
        $permitido = $r['cliente_id'] !== null
            ? (int) $r['cliente_id'] === $clienteId
            : $r['reservado_por'] === $usuario;
        if (!$permitido) {
            return Resultado::erro('FTTH-TOP-011', ['numero' => $numero, 'expira_em' => $r['expira_em']],
                'Essa saída está reservada' . ($r['referencia'] ? ' para ' . $r['referencia'] : '')
                . ' até ' . $r['expira_em'] . '.');
        }
        return null;
    }

    /** Deve ser chamada após o INSERT de vínculo, na mesma transação. */
    public static function consumir(int $splitterId, int $numero, int $regiaoId): void
    {
        if (!Db::tabelaExiste('tab_ftth_reserva_porta')) return;
        $r = Db::um(
            'SELECT id, cliente_id, referencia, reservado_por, expira_em
               FROM tab_ftth_reserva_porta WHERE splitter_id = ? AND numero = ? FOR UPDATE',
            [$splitterId, $numero]);
        if (!$r) return;
        Db::exec('DELETE FROM tab_ftth_reserva_porta WHERE id = ?', [(int) $r['id']]);
        Auditoria::registrar('reserva_porta', (int) $r['id'], 'consumir', $r,
            ['splitter_id' => $splitterId, 'numero' => $numero], $regiaoId);
    }

    public static function cancelar(int $id, string $usuario): Resultado
    {
        return Db::transacao(function () use ($id, $usuario) {
            $r = Db::um(
                'SELECT rp.*, s.nome AS splitter_nome, c.nome AS caixa_nome, c.regiao_id
                   FROM tab_ftth_reserva_porta rp JOIN tab_ftth_splitter s ON s.id = rp.splitter_id
                   JOIN tab_ftth_caixa c ON c.id = s.caixa_id
                  WHERE rp.id = ? FOR UPDATE', [$id]);
            if (!$r) return Resultado::erro('FTTH-SYS-002', ['id' => $id], 'Reserva não encontrada.');
            Db::exec('DELETE FROM tab_ftth_reserva_porta WHERE id = ?', [$id]);
            Auditoria::registrar('reserva_porta', $id, 'cancelar', $r, null, (int) $r['regiao_id']);
            return Resultado::ok(['caixa_nome' => $r['caixa_nome'], 'splitter_nome' => $r['splitter_nome'],
                'numero' => (int) $r['numero'], 'cancelado_por' => $usuario]);
        });
    }
}
