<?php
/** Utilidades puras de coordenadas usadas na busca comercial. */
final class GeoTools
{
    /** Lê lat,lng no formato decimal com ponto e rejeita coordenadas fora da faixa. */
    public static function coordenadas(string $texto): ?array
    {
        if (!preg_match('/^\s*([+-]?(?:\d{1,2})(?:\.\d+)?)\s*,\s*([+-]?(?:\d{1,3})(?:\.\d+)?)\s*$/', $texto, $m)) {
            return null;
        }
        $lat = (float) $m[1];
        $lng = (float) $m[2];
        if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
            return null;
        }
        return ['lat' => $lat, 'lng' => $lng];
    }

    /** Raio permitido para a consulta comercial (metros). */
    public static function raio($valor): ?int
    {
        if (!is_numeric($valor)) {
            return null;
        }
        $n = (float) $valor;
        if ($n < 100 || $n > 5000 || floor($n) !== $n) {
            return null;
        }
        return (int) $n;
    }

    /** Distância de grande círculo entre dois pontos, em metros. */
    public static function distanciaMetros(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $rad = M_PI / 180;
        $dLat = ($lat2 - $lat1) * $rad;
        $dLng = ($lng2 - $lng1) * $rad;
        $a = sin($dLat / 2) ** 2
            + cos($lat1 * $rad) * cos($lat2 * $rad) * sin($dLng / 2) ** 2;
        return 6371008.8 * 2 * atan2(sqrt(min(1.0, $a)), sqrt(max(0.0, 1.0 - $a)));
    }

    /** Ordena os pontos pelo mais próximo, limita o raio e não devolve coordenadas inválidas. */
    public static function ordenarPontos(array $pontos, float $lat, float $lng,
                                         int $raioM, int $limite): array
    {
        $saida = [];
        foreach ($pontos as $p) {
            if (!isset($p['lat'], $p['lng']) || !is_numeric($p['lat']) || !is_numeric($p['lng'])) {
                continue;
            }
            $a = (float) $p['lat'];
            $b = (float) $p['lng'];
            if ($a < -90 || $a > 90 || $b < -180 || $b > 180) {
                continue;
            }
            $d = self::distanciaMetros($lat, $lng, $a, $b);
            if ($d <= $raioM) {
                $p['distancia_m'] = (int) round($d);
                $saida[] = $p;
            }
        }
        usort($saida, static function ($a, $b) {
            return $a['distancia_m'] <=> $b['distancia_m'];
        });
        return array_slice($saida, 0, max(0, min(20, $limite)));
    }
}
