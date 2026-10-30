<?php
/**
 * Read-only bridge to OLTManager tables. This addon never reads ONU tables or OLT credentials.
 */
require_once __DIR__ . '/Db.php';

final class OltManager
{
    public static function disponivel(): bool
    {
        return Db::tabelaExiste('addon_olt_olts') && Db::tabelaExiste('addon_olt_pons');
    }

    /** Safe fields only; host and all access credentials remain inside OLTManager. */
    public static function listarOlts(): array
    {
        if (!self::disponivel()) {
            return [];
        }
        try {
            return Db::todos(
                'SELECT id, nome, fabricante FROM addon_olt_olts WHERE ativo = 1 ORDER BY nome, id'
            );
        } catch (Throwable $e) {
            return [];
        }
    }

    /** PON inventory and its current TX reading, scoped to the selected OLT. */
    public static function listarPons(int $oltManagerId): array
    {
        if ($oltManagerId <= 0 || !self::disponivel()) {
            return [];
        }
        try {
            return Db::todos(
                'SELECT id, nome, tx_power, ultimo_sinal_em
                   FROM addon_olt_pons
                  WHERE olt_id = ? AND ativo = 1
                  ORDER BY COALESCE(frame_num, 999), COALESCE(slot_num, 999), COALESCE(porta_num, 999), nome, id',
                [$oltManagerId]
            );
        } catch (Throwable $e) {
            return [];
        }
    }

    /** Batch-read only the optical TX value and collection timestamp for linked PONs. */
    public static function leiturasPons(array $ponIds): array
    {
        if (!$ponIds || !self::disponivel()) {
            return [];
        }
        $ids = array_values(array_unique(array_filter(array_map('intval', $ponIds), static function ($id) {
            return $id > 0;
        })));
        if (!$ids) {
            return [];
        }
        try {
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $rows = Db::todos(
                'SELECT p.id, p.olt_id, p.tx_power, p.ultimo_sinal_em,
                        o.rx_cron_ativo AS coleta_ativa,
                        o.rx_cron_intervalo_horas AS intervalo_coleta_horas,
                        TIMESTAMPDIFF(SECOND, p.ultimo_sinal_em, NOW()) AS idade_segundos
                   FROM addon_olt_pons p
                   JOIN addon_olt_olts o ON o.id = p.olt_id
                  WHERE p.id IN (' . $placeholders . ') AND p.ativo = 1 AND o.ativo = 1',
                $ids
            );
            $result = [];
            foreach ($rows as $row) {
                $result[(int) $row['id']] = $row;
            }
            return $result;
        } catch (Throwable $e) {
            return [];
        }
    }

    public static function oltExiste(int $oltManagerId): bool
    {
        if ($oltManagerId <= 0 || !self::disponivel()) {
            return false;
        }
        try {
            return Db::um(
                'SELECT id FROM addon_olt_olts WHERE id = ? AND ativo = 1',
                [$oltManagerId]
            ) !== null;
        } catch (Throwable $e) {
            return false;
        }
    }

    public static function ponPertence(int $ponId, int $oltManagerId): bool
    {
        if ($ponId <= 0 || $oltManagerId <= 0 || !self::disponivel()) {
            return false;
        }
        try {
            return Db::um(
                'SELECT id FROM addon_olt_pons WHERE id = ? AND olt_id = ? AND ativo = 1',
                [$ponId, $oltManagerId]
            ) !== null;
        } catch (Throwable $e) {
            return false;
        }
    }
}