<?php
/** Busca em largura independente do banco para simular alcançabilidade no grafo FTTH. */
final class Impacto
{
    /**
     * @param array<string,array<int,array{para:string,vao_id?:int,fibra?:int}>> $adjacencia
     * @param string[] $origens
     * @param array{vao_id:int,fibra:int}|null $rompimento
     * @return array<string,true>
     */
    public static function alcancaveis(array $adjacencia, array $origens, ?array $rompimento): array
    {
        $visitados = [];
        $fila = [];
        foreach ($origens as $o) {
            if (!isset($visitados[$o])) {
                $visitados[$o] = true;
                $fila[] = $o;
            }
        }
        for ($i = 0; $i < count($fila); $i++) {
            $de = $fila[$i];
            foreach ($adjacencia[$de] ?? [] as $aresta) {
                if ($rompimento !== null
                    && (int) ($aresta['vao_id'] ?? 0) === (int) $rompimento['vao_id']
                    && (int) ($aresta['fibra'] ?? 0) === (int) $rompimento['fibra']) {
                    continue;
                }
                $para = (string) $aresta['para'];
                if (!isset($visitados[$para])) {
                    $visitados[$para] = true;
                    $fila[] = $para;
                }
            }
        }
        return $visitados;
    }
}
