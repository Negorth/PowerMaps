<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/lib/Operacao.php';
require_once __DIR__ . '/lib/Impacto.php';

if (isset($_GET['ajax'])) {
    try {
        switch ($_GET['ajax']) {
            case 'capacidade': Resultado::ok(Operacao::capacidade())->enviar();
            case 'pendencias': Resultado::ok(Operacao::pendencias())->enviar();
            case 'vaos': Resultado::ok(['vaos' => Operacao::vaos()])->enviar();
            case 'impacto':
                $vao = (int) ($_GET['vao'] ?? 0);
                $fibra = (int) ($_GET['fibra'] ?? 0);
                $d = Potencia::impactoVao($vao, $fibra);
                $d ? Resultado::ok($d)->enviar()
                    : Resultado::erro('FTTH-SYS-002', [], 'Escolha um vão e um número de fibra válidos.')->enviar(400);
            default: Resultado::erro('FTTH-SYS-002')->enviar(400);
        }
    } catch (Throwable $e) {
        Log::excecao('operacao.ajax', $e, ['ajax' => $_GET['ajax'] ?? '']);
        Resultado::erro('FTTH-SYS-001')->enviar(500);
    }
}

include('nav/header.php');
?>
<body>
<?php include('../../topo.php'); ?>
<main class="ftth-wrap ftth-operacao">
    <div class="ftth-op-topo">
        <div><h1 class="ftth-titulo">Operação da rede</h1>
            <p class="ftth-sub">Capacidade, documentação e impacto estimado por fibra.</p></div>
        <nav class="ftth-acoes-topo">
            <a class="ftth-btn ftth-btn--sec" href="mapa.php"><i class="bi-map"></i> Mapa</a>
            <a class="ftth-btn ftth-btn--pri" href="campo.php"><i class="bi-tools"></i> Abrir ficha de campo</a>
        </nav>
    </div>
    <div class="ftth-op-abas" role="tablist" aria-label="Ferramentas de operação">
        <button type="button" class="ativo" id="tab-capacidade" data-tab="capacidade" role="tab" aria-controls="op-capacidade" aria-selected="true">Capacidade</button>
        <button type="button" id="tab-pendencias" data-tab="pendencias" role="tab" aria-controls="op-pendencias" aria-selected="false">Revisar documentação</button>
        <button type="button" id="tab-impacto" data-tab="impacto" role="tab" aria-controls="op-impacto" aria-selected="false">Simular falha</button>
    </div>
    <section class="ftth-op-secao ativa" id="op-capacidade" aria-labelledby="tab-capacidade">
        <div class="ftth-card">
            <div class="ftth-card-topo"><h2>Portas por região, OLT/PON e CTO</h2>
                <button type="button" class="ftth-btn ftth-btn--sec" id="op-atualizar-capacidade">Atualizar</button></div>
            <p class="ftth-sub">Portas livres, ocupadas e reservadas contam somente splitters de atendimento. “Origem não identificada” indica falta de caminho documentado.</p>
            <div class="ftth-op-filtros ftth-op-capacidade-filtros">
                <label>Região<select id="op-capacidade-regiao" class="ftth-campo"><option value="">Todas as regiões</option></select></label>
                <label>Buscar OLT, PON ou CTO<input id="op-capacidade-busca" class="ftth-campo" type="search" placeholder="Digite para filtrar"></label>
                <button type="button" class="ftth-btn ftth-btn--sec" id="op-capacidade-csv">Exportar CSV</button>
            </div>
            <div id="op-capacidade-status" class="ftth-op-status" role="status"></div>
            <div class="ftth-op-tabela-scroll"><table class="ftth-op-tabela"><thead><tr>
                <th>Região</th><th>OLT</th><th>PON</th><th>CTO</th><th>Pontas de fibra conectadas</th>
                <th>Ocupadas</th><th>Reservadas</th><th>Livres</th><th>Total</th>
            </tr></thead><tbody id="op-capacidade-linhas"></tbody></table></div>
        </div>
    </section>
    <section class="ftth-op-secao" id="op-pendencias" aria-labelledby="tab-pendencias">
        <div class="ftth-card">
            <div class="ftth-card-topo"><h2>Verificações da documentação</h2>
                <button type="button" class="ftth-btn ftth-btn--sec" id="op-atualizar-pendencias">Revisar</button></div>
            <p class="ftth-sub">As verificações mostram dados ausentes ou divergentes no cadastro. Isso não confirma defeito físico.</p>
            <div id="op-pendencias-status" class="ftth-op-status" role="status"></div>
            <div id="op-pendencias-lista" class="ftth-op-lista"></div>
        </div>
    </section>
    <section class="ftth-op-secao" id="op-impacto" aria-labelledby="tab-impacto">
        <div class="ftth-card">
            <div class="ftth-card-topo"><h2>Simular interrupção de uma fibra</h2></div>
            <p class="ftth-sub">Escolha um trecho e uma fibra. A simulação usa as emendas e caminhos cadastrados e verifica se há outro caminho que mantenha a saída alcançável.</p>
            <div class="ftth-op-filtros">
                <label>Trecho do cabo<select id="op-vao" class="ftth-campo"><option value="">Carregando trechos…</option></select></label>
                <label>Fibra<input id="op-fibra" class="ftth-campo" type="number" min="1" value="1"></label>
                <button type="button" class="ftth-btn ftth-btn--pri" id="op-simular">Simular impacto</button>
            </div>
            <div id="op-impacto-resultado" aria-live="polite"></div>
        </div>
    </section>
</main>
<script src="js/operacao.js?v=<?= time() ?>"></script>
<?php include('../../baixo.php'); ?>
<script src="../../menu.js<?= $ext_mk ?>"></script>
</body>
</html>
