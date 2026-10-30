<?php
/** Cálculos puros para impedir dupla contagem de portas entre as duas tabelas de vínculo. */
final class Capacidade
{
    public static function estado(bool $ocupada, bool $reservada): string
    {
        if ($ocupada) return 'ocupada';
        if ($reservada) return 'reservada';
        return 'livre';
    }

    /**
     * @param array $splitters linhas id,nome,saidas
     * @param array $ocupacoes linhas splitter_id,numero (principal e adicional juntas)
     * @param array $reservas linhas splitter_id,numero,ativa
     */
    public static function resumir(array $splitters, array $ocupacoes, array $reservas): array
    {
        $ocupadas = [];
        foreach ($ocupacoes as $o) {
            $chave = (int) $o['splitter_id'] . ':' . (int) $o['numero'];
            $ocupadas[$chave] = true;
        }
        $reservadas = [];
        foreach ($reservas as $r) {
            if (isset($r['ativa']) && !$r['ativa']) continue;
            $chave = (int) $r['splitter_id'] . ':' . (int) $r['numero'];
            $reservadas[$chave] = $r;
        }

        $saida = ['total' => 0, 'ocupadas' => 0, 'reservadas' => 0, 'livres' => 0, 'splitters' => []];
        foreach ($splitters as $s) {
            $linhas = ['id' => (int) $s['id'], 'nome' => (string) $s['nome'],
                'total' => (int) $s['saidas'], 'ocupadas' => 0, 'reservadas' => 0, 'livres' => 0];
            for ($n = 1; $n <= (int) $s['saidas']; $n++) {
                $chave = (int) $s['id'] . ':' . $n;
                $estado = self::estado(isset($ocupadas[$chave]), isset($reservadas[$chave]));
                $linhas[$estado === 'ocupada' ? 'ocupadas' : ($estado === 'reservada' ? 'reservadas' : 'livres')]++;
            }
            $saida['total'] += $linhas['total'];
            $saida['ocupadas'] += $linhas['ocupadas'];
            $saida['reservadas'] += $linhas['reservadas'];
            $saida['livres'] += $linhas['livres'];
            $saida['splitters'][] = $linhas;
        }
        return $saida;
    }
}
