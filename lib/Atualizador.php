<?php
/**
 * FTTH Doc :: solicita atualizações sem expor execução de comandos ao PHP.
 *
 * O processo web só cria um marcador fixo em FTTH_DIR_DADOS e lê o status publicado pelo
 * worker root-owned. Toda validação, download e instalação fica no worker do systemd.
 */
final class Atualizador
{
    private const ARQUIVO_PRONTO = 'update-helper.ready';
    private const ARQUIVO_PEDIDO = 'update.request';
    private const ARQUIVO_STATUS = 'update-status.json';
    private const LOCK_PHP = '.update-request.lock';
    private const VALIDADE_PEDIDO = 300;
    private const VALIDADE_EXECUCAO = 3600;

    private static function caminho(string $nome): string
    {
        return rtrim(FTTH_DIR_DADOS, '/\\') . DIRECTORY_SEPARATOR . $nome;
    }

    private static function pronto(): bool
    {
        $arquivo = self::caminho(self::ARQUIVO_PRONTO);
        return is_file($arquivo) && !is_link($arquivo) && is_readable($arquivo);
    }

    private static function lerStatus(): array
    {
        $arquivo = self::caminho(self::ARQUIVO_STATUS);
        if (!is_file($arquivo) || is_link($arquivo) || !is_readable($arquivo)) {
            return [];
        }

        $dados = json_decode((string) @file_get_contents($arquivo), true);
        if (!is_array($dados)) {
            return [];
        }

        $estado = (string) ($dados['estado'] ?? '');
        if (!in_array($estado, ['running', 'succeeded', 'failed'], true)) {
            return [];
        }

        $versao = (string) ($dados['versao'] ?? '');
        if ($versao !== '' && !preg_match('/^v?[0-9]+\.[0-9]+\.[0-9]+$/', $versao)) {
            $versao = '';
        }

        $mensagem = strip_tags((string) ($dados['mensagem'] ?? ''));
        $mensagem = preg_replace('/[\x00-\x1F\x7F]/', ' ', $mensagem) ?? '';

        return [
            'estado' => $estado,
            'versao' => $versao,
            'atualizado_em' => max(0, (int) ($dados['atualizado_em'] ?? 0)),
            'mensagem' => substr($mensagem, 0, 240),
        ];
    }

    public static function estado(): array
    {
        $status = self::lerStatus();
        $pedido = self::caminho(self::ARQUIVO_PEDIDO);

        if (is_file($pedido) && !is_link($pedido)) {
            $mtime = @filemtime($pedido) ?: 0;
            if ($mtime > 0 && time() - $mtime <= self::VALIDADE_PEDIDO) {
                return [
                    'configurado' => self::pronto(),
                    'estado' => 'pending',
                    'versao' => '',
                    'atualizado_em' => $mtime,
                    'mensagem' => 'Solicitação na fila.',
                ];
            }
        }

        if (($status['estado'] ?? '') === 'running'
            && time() - ($status['atualizado_em'] ?? 0) > self::VALIDADE_EXECUCAO) {
            $status = [
                'estado' => 'failed',
                'versao' => $status['versao'] ?? '',
                'atualizado_em' => $status['atualizado_em'] ?? 0,
                'mensagem' => 'A tarefa excedeu o tempo limite. Confira o log do instalador no servidor.',
            ];
        }

        return [
            'configurado' => self::pronto(),
            'estado' => $status['estado'] ?? 'idle',
            'versao' => $status['versao'] ?? '',
            'atualizado_em' => $status['atualizado_em'] ?? 0,
            'mensagem' => $status['mensagem'] ?? '',
        ];
    }

    public static function solicitar(): array
    {
        if (!self::pronto()) {
            throw new RuntimeException('O auxiliar de atualização ainda não foi configurado pelo instalador root.');
        }

        $diretorio = rtrim(FTTH_DIR_DADOS, '/\\');
        if (!is_dir($diretorio) || !is_writable($diretorio)) {
            throw new RuntimeException('A pasta de dados do addon não está disponível para gravar a solicitação.');
        }

        $lock = @fopen(self::caminho(self::LOCK_PHP), 'c');
        if (!$lock || !flock($lock, LOCK_EX)) {
            if (is_resource($lock)) {
                fclose($lock);
            }
            throw new RuntimeException('Não foi possível reservar a solicitação de atualização.');
        }

        try {
            $pedido = self::caminho(self::ARQUIVO_PEDIDO);
            if (is_link($pedido)) {
                throw new RuntimeException('O marcador de atualização está inválido; peça ao administrador para revisar o servidor.');
            }

            $estado = self::estado();
            if (($estado['estado'] ?? '') === 'running') {
                return $estado;
            }

            if (is_file($pedido)) {
                $mtime = @filemtime($pedido) ?: 0;
                if ($mtime > 0 && time() - $mtime <= self::VALIDADE_PEDIDO) {
                    return self::estado();
                }
                @unlink($pedido);
            }

            $temporario = @tempnam($diretorio, '.update-request-');
            if ($temporario === false) {
                throw new RuntimeException('Não foi possível criar a solicitação de atualização.');
            }
            $diretorioReal = realpath($diretorio);
            $temporarioReal = realpath($temporario);
            if ($diretorioReal === false || $temporarioReal === false
                || dirname($temporarioReal) !== $diretorioReal) {
                @unlink($temporario);
                throw new RuntimeException('Não foi possível criar a solicitação dentro da pasta permitida.');
            }

            $gravado = @file_put_contents($temporario, (string) time(), LOCK_EX);
            @chmod($temporario, 0640);
            if ($gravado === false || !@rename($temporario, $pedido)) {
                @unlink($temporario);
                throw new RuntimeException('Não foi possível enfileirar a atualização.');
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }

        return self::estado();
    }
}
