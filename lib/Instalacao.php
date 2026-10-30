<?php
/**
 * Instalações adicionais por cliente.
 *
 * A instalação principal continua representada pelo cadastro nativo e por tab_ftth_porta.
 * Esta entidade guarda somente endereços/pontos adicionais, sem gravá-los em sis_cliente.
 */
require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/Geo.php';
require_once __DIR__ . '/Auditoria.php';
require_once __DIR__ . '/Resultado.php';
require_once __DIR__ . '/Sincronizacao.php';
require_once __DIR__ . '/ReservaPorta.php';

final class Instalacao
{
    public static function listar(int $clienteId): ?array
    {
        $cliente = Db::um(
            'SELECT id, login, nome, endereco, numero, bairro, coordenadas, cli_ativado
               FROM sis_cliente WHERE id = ?', [$clienteId]);
        if (!$cliente) {
            return null;
        }
        $ponto = Geo::pontoCadastro($cliente['coordenadas'] ?? '');
        $cliente['endereco_exibicao'] = trim(implode(' ', array_filter([
            $cliente['endereco'] ?? '', $cliente['numero'] ?? '', $cliente['bairro'] ?? '',
        ], static function ($v) { return trim((string) $v) !== ''; })));
        $cliente['coordenada'] = $ponto;
        unset($cliente['coordenadas']);
        $cliente['principal'] = Topologia::portaDoCliente($clienteId);
        $cliente['principal_ativa'] = $cliente['cli_ativado'] === 's';
        unset($cliente['cli_ativado']);

        $instalacoes = Db::todos(
            'SELECT i.id, i.identificacao, i.endereco, i.lat, i.lng, i.observacao,
                    ip.id AS vinculo_id, ip.splitter_id, ip.numero, ip.login,
                    s.nome AS splitter_nome, c.id AS caixa_id, c.nome AS caixa_nome
               FROM tab_ftth_instalacao i
               LEFT JOIN tab_ftth_instalacao_porta ip ON ip.instalacao_id = i.id
               LEFT JOIN tab_ftth_splitter s ON s.id = ip.splitter_id
               LEFT JOIN tab_ftth_caixa c ON c.id = s.caixa_id
              WHERE i.cliente_id = ?
              ORDER BY i.id', [$clienteId]);
        foreach ($instalacoes as &$i) {
            $i['id'] = (int) $i['id'];
            $i['lat'] = (float) $i['lat'];
            $i['lng'] = (float) $i['lng'];
            $i['numero'] = $i['numero'] === null ? null : (int) $i['numero'];
            $i['splitter_id'] = $i['splitter_id'] === null ? null : (int) $i['splitter_id'];
        }
        unset($i);
        return ['cliente' => $cliente, 'instalacoes' => $instalacoes];
    }

    public static function criar(int $clienteId, string $identificacao, string $endereco,
                                 $lat, $lng, string $observacao, string $usuario): Resultado
    {
        $cliente = self::clienteAtivo($clienteId);
        if (!$cliente) {
            return Resultado::erro('FTTH-SYS-002', ['cliente_id' => $clienteId],
                'Cliente não encontrado ou não está ativo.');
        }
        $identificacao = trim($identificacao);
        $endereco = trim($endereco);
        $observacao = trim($observacao);
        $ponto = self::validarPonto($lat, $lng);
        if (mb_strlen($identificacao) < 2 || mb_strlen($identificacao) > 80
            || mb_strlen($endereco) > 180 || mb_strlen($observacao) > 500 || !$ponto) {
            return Resultado::erro('FTTH-SYS-002', [],
                'Informe a identificação e coordenadas válidas.');
        }

        return Db::transacao(function () use ($clienteId, $identificacao, $endereco, $ponto,
                                               $observacao, $usuario, $cliente) {
            Db::exec(
                'INSERT INTO tab_ftth_instalacao
                    (cliente_id, identificacao, endereco, lat, lng, observacao, criado_por, criado_em)
                 VALUES (?,?,?,?,?,?,?,NOW())',
                [$clienteId, $identificacao, $endereco !== '' ? $endereco : null,
                 $ponto['lat'], $ponto['lng'], $observacao !== '' ? $observacao : null, $usuario]
            );
            $id = Db::ultimoId();
            Auditoria::registrar('instalacao', $id, 'criar', null, [
                'cliente_id' => $clienteId, 'login' => $cliente['login'],
                'identificacao' => $identificacao, 'endereco' => $endereco,
                'lat' => $ponto['lat'], 'lng' => $ponto['lng'], 'observacao' => $observacao,
            ]);
            return Resultado::ok(['id' => $id, 'cliente_id' => $clienteId]);
        });
    }

    public static function alterar(int $id, int $clienteId, string $identificacao, string $endereco,
                                   $lat, $lng, string $observacao, string $usuario): Resultado
    {
        $identificacao = trim($identificacao);
        $endereco = trim($endereco);
        $observacao = trim($observacao);
        $ponto = self::validarPonto($lat, $lng);
        if (mb_strlen($identificacao) < 2 || mb_strlen($identificacao) > 80
            || mb_strlen($endereco) > 180 || mb_strlen($observacao) > 500 || !$ponto) {
            return Resultado::erro('FTTH-SYS-002', [],
                'Informe a identificação e coordenadas válidas.');
        }

        return Db::transacao(function () use ($id, $clienteId, $identificacao, $endereco, $ponto,
                                               $observacao, $usuario) {
            $atual = Db::um(
                'SELECT * FROM tab_ftth_instalacao WHERE id = ? AND cliente_id = ? FOR UPDATE',
                [$id, $clienteId]);
            if (!$atual || !self::clienteAtivo($clienteId)) {
                return Resultado::erro('FTTH-SYS-002', ['instalacao_id' => $id],
                    'Instalação ou cliente ativo não encontrado.');
            }
            Db::exec(
                'UPDATE tab_ftth_instalacao
                    SET identificacao = ?, endereco = ?, lat = ?, lng = ?, observacao = ?,
                        alterado_por = ?, alterado_em = NOW()
                  WHERE id = ? AND cliente_id = ?',
                [$identificacao, $endereco !== '' ? $endereco : null, $ponto['lat'], $ponto['lng'],
                 $observacao !== '' ? $observacao : null, $usuario, $id, $clienteId]
            );
            Auditoria::registrar('instalacao', $id, 'alterar', [
                'identificacao' => $atual['identificacao'], 'endereco' => $atual['endereco'],
                'lat' => (float) $atual['lat'], 'lng' => (float) $atual['lng'],
                'observacao' => $atual['observacao'],
            ], ['identificacao' => $identificacao, 'endereco' => $endereco,
                'lat' => $ponto['lat'], 'lng' => $ponto['lng'], 'observacao' => $observacao]);
            return Resultado::ok(['id' => $id, 'cliente_id' => $clienteId]);
        });
    }

    public static function excluir(int $id, int $clienteId): Resultado
    {
        return Db::transacao(function () use ($id, $clienteId) {
            // O mesmo lock é usado pelo vínculo: uma instalação não pode ser vinculada
            // enquanto outra requisição a exclui após conferir que estava livre.
            $atual = Db::um(
                'SELECT id, identificacao, endereco, lat, lng, observacao FROM tab_ftth_instalacao
                  WHERE id = ? AND cliente_id = ? FOR UPDATE', [$id, $clienteId]);
            if (!$atual) {
                return Resultado::erro('FTTH-SYS-002', ['instalacao_id' => $id], 'Instalação não encontrada.');
            }
            if (Db::valor('SELECT id FROM tab_ftth_instalacao_porta WHERE instalacao_id = ?', [$id])) {
                return Resultado::erro('FTTH-SYS-002', ['instalacao_id' => $id],
                    'Desvincule a instalação da CTO antes de excluí-la.');
            }
            Db::exec('DELETE FROM tab_ftth_instalacao WHERE id = ? AND cliente_id = ?', [$id, $clienteId]);
            Auditoria::registrar('instalacao', $id, 'excluir', [
                'cliente_id' => $clienteId, 'identificacao' => $atual['identificacao'],
                'endereco' => $atual['endereco'], 'lat' => (float) $atual['lat'],
                'lng' => (float) $atual['lng'], 'observacao' => $atual['observacao'],
            ]);
            return Resultado::ok(['id' => $id, 'cliente_id' => $clienteId]);
        });
    }

    /** Cliente e porta nativa usam tabelas distintas; esta consulta cruza a ocupação adicional. */
    public static function portaOcupada(int $splitterId, int $numero): ?array
    {
        return Db::um(
            'SELECT ip.instalacao_id, ip.cliente_id, ip.login, i.identificacao
               FROM tab_ftth_instalacao_porta ip
               JOIN tab_ftth_instalacao i ON i.id = ip.instalacao_id
              WHERE ip.splitter_id = ? AND ip.numero = ?', [$splitterId, $numero]);
    }

    public static function vincular(int $id, int $clienteId, int $splitterId, int $numero,
                                    string $usuario): Resultado
    {
        if ($numero < 1) {
            return Resultado::erro('FTTH-SYS-002', ['numero' => $numero], 'Número de porta inválido.');
        }

        return Db::transacao(function () use ($id, $clienteId, $splitterId, $numero,
                                               $usuario) {
            // Trava primeiro a instalação, na mesma ordem que excluir/desvincular.
            $instalacao = Db::um(
                'SELECT id, identificacao FROM tab_ftth_instalacao
                  WHERE id = ? AND cliente_id = ? FOR UPDATE', [$id, $clienteId]);
            if (!$instalacao) {
                return Resultado::erro('FTTH-SYS-002', ['instalacao_id' => $id], 'Instalação não encontrada.');
            }
            $cliente = self::clienteAtivo($clienteId);
            if (!$cliente) {
                return Resultado::erro('FTTH-SYS-002', ['cliente_id' => $clienteId],
                    'Cliente não encontrado ou não está ativo.');
            }
            $splitter = Db::um(
                'SELECT s.id, s.nome, s.funcao, s.saidas, s.excluido_em, c.id AS caixa_id,
                        c.nome AS caixa_nome, c.regiao_id, c.excluido_em AS caixa_excluido
                   FROM tab_ftth_splitter s
                   JOIN tab_ftth_caixa c ON c.id = s.caixa_id
                  WHERE s.id = ? FOR UPDATE', [$splitterId]);
            if (!$splitter || $splitter['excluido_em'] !== null || $splitter['caixa_excluido'] !== null
                || $splitter['funcao'] !== 'ATENDIMENTO' || $numero > (int) $splitter['saidas']) {
                return Resultado::erro('FTTH-TOP-009', ['splitter' => $splitterId],
                    'Selecione uma porta válida de um splitter de atendimento ativo.');
            }

            $legada = Db::um(
                'SELECT cliente_id, login FROM tab_ftth_porta WHERE splitter_id = ? AND numero = ?',
                [$splitterId, $numero]);
            if ($legada) {
                return Resultado::erro('FTTH-TOP-011', ['splitter' => $splitterId, 'numero' => $numero,
                    'login' => $legada['login']],
                    'Esta porta já atende ' . $legada['login'] . ' pela instalação principal.');
            }
            $ocupada = self::portaOcupada($splitterId, $numero);
            if ($ocupada && (int) $ocupada['instalacao_id'] !== $id) {
                return Resultado::erro('FTTH-TOP-011', ['splitter' => $splitterId, 'numero' => $numero,
                    'login' => $ocupada['login'], 'instalacao' => $ocupada['identificacao']],
                    'Esta porta já está ocupada por outra instalação.');
            }
            $ligacao = Db::um(
                'SELECT ligacao_id FROM tab_ftth_ligacao_ponta
                  WHERE elemento = "SPLITTER_OUT" AND elemento_id = ? AND numero = ? LIMIT 1',
                [$splitterId, $numero]);
            if ($ligacao) {
                return Resultado::erro('FTTH-TOP-011', ['splitter' => $splitterId, 'numero' => $numero],
                    'Esta saída já alimenta um cabo ou outro splitter e não pode receber uma instalação.');
            }

            $bloqueioReserva = ReservaPorta::autorizarUso($splitterId, $numero, $clienteId, $usuario);
            if ($bloqueioReserva) return $bloqueioReserva;

            $atual = Db::um('SELECT id, splitter_id, numero FROM tab_ftth_instalacao_porta
                              WHERE instalacao_id = ? FOR UPDATE', [$id]);
            if ($atual) {
                if ((int) $atual['splitter_id'] !== $splitterId || (int) $atual['numero'] !== $numero) {
                    return Resultado::erro('FTTH-TOP-012', ['instalacao_id' => $id],
                        'Desvincule esta instalação da porta atual antes de movê-la.');
                }
                return Resultado::ok(['id' => (int) $atual['id'], 'ja_vinculada' => true,
                    'cliente_id' => $clienteId, 'instalacao_id' => $id,
                    'caixa_nome' => $splitter['caixa_nome'], 'splitter_nome' => $splitter['nome'],
                    'numero' => $numero]);
            }

            Db::exec(
                'INSERT INTO tab_ftth_instalacao_porta
                    (instalacao_id, splitter_id, numero, cliente_id, login, criado_por, criado_em)
                 VALUES (?,?,?,?,?,?,NOW())',
                [$id, $splitterId, $numero, $clienteId, $cliente['login'], $usuario]
            );
            $vinculoId = Db::ultimoId();
            ReservaPorta::consumir($splitterId, $numero, (int) $splitter['regiao_id']);
            Auditoria::registrar('instalacao_porta', $vinculoId, 'vincular', null, [
                'cliente_id' => $clienteId, 'login' => $cliente['login'], 'instalacao_id' => $id,
                'identificacao' => $instalacao['identificacao'], 'caixa' => $splitter['caixa_nome'],
                'splitter' => $splitter['nome'], 'numero' => $numero,
            ], (int) $splitter['regiao_id']);
            return Sincronizacao::caixa((int) $splitter['caixa_id'], Resultado::ok([
                'id' => $vinculoId, 'cliente_id' => $clienteId, 'instalacao_id' => $id,
                'login' => $cliente['login'], 'identificacao' => $instalacao['identificacao'],
                'caixa_nome' => $splitter['caixa_nome'], 'splitter_nome' => $splitter['nome'],
                'numero' => $numero,
            ]), $usuario);
        });
    }

    public static function desvincular(int $id, int $clienteId, string $usuario): Resultado
    {
        return Db::transacao(function () use ($id, $clienteId, $usuario) {
            // Serializa com vínculo e exclusão antes de consultar o vínculo atual.
            $instalacao = Db::um(
                'SELECT id FROM tab_ftth_instalacao WHERE id = ? AND cliente_id = ? FOR UPDATE',
                [$id, $clienteId]);
            if (!$instalacao) {
                return Resultado::erro('FTTH-SYS-002', ['instalacao_id' => $id], 'Instalação não encontrada.');
            }
            $atual = Db::um(
                'SELECT ip.id, ip.splitter_id, ip.numero, ip.login, s.nome AS splitter_nome,
                        c.id AS caixa_id, c.nome AS caixa_nome, c.regiao_id, i.identificacao
                   FROM tab_ftth_instalacao_porta ip
                   JOIN tab_ftth_instalacao i ON i.id = ip.instalacao_id
                   JOIN tab_ftth_splitter s ON s.id = ip.splitter_id
                   JOIN tab_ftth_caixa c ON c.id = s.caixa_id
                  WHERE ip.instalacao_id = ? AND ip.cliente_id = ? AND i.cliente_id = ?',
                [$id, $clienteId, $clienteId]);
            if (!$atual) {
                return Resultado::erro('FTTH-SYS-002', ['instalacao_id' => $id],
                    'Esta instalação não está vinculada a uma porta.');
            }
            Db::exec('DELETE FROM tab_ftth_instalacao_porta WHERE id = ?', [(int) $atual['id']]);
            Auditoria::registrar('instalacao_porta', (int) $atual['id'], 'desvincular', [
                'cliente_id' => $clienteId, 'login' => $atual['login'],
                'identificacao' => $atual['identificacao'], 'caixa' => $atual['caixa_nome'],
                'splitter' => $atual['splitter_nome'], 'numero' => (int) $atual['numero'],
            ], null, (int) $atual['regiao_id']);
            return Sincronizacao::caixa((int) $atual['caixa_id'],
                Resultado::ok(['cliente_id' => $clienteId, 'instalacao_id' => $id]), $usuario);
        });
    }

    private static function clienteAtivo(int $clienteId): ?array
    {
        return Db::um('SELECT id, login, nome FROM sis_cliente WHERE id = ? AND cli_ativado = "s"',
            [$clienteId]);
    }

    private static function validarPonto($lat, $lng): ?array
    {
        if (!is_numeric($lat) || !is_numeric($lng)) {
            return null;
        }
        $lat = (float) $lat;
        $lng = (float) $lng;
        if (!is_finite($lat) || !is_finite($lng)
            || $lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
            return null;
        }
        return ['lat' => $lat, 'lng' => $lng];
    }
}
