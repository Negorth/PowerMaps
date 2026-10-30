<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/lib/Campo.php';
require_once __DIR__ . '/lib/ReservaPorta.php';

$caixaId = (int) ($_GET['caixa'] ?? 0);

if (isset($_GET['foto'])) {
    $foto = Campo::caminhoFoto((int) $_GET['foto']);
    if (!$foto) { http_response_code(404); exit('Foto não encontrada.'); }
    header('Content-Type: ' . $foto['mime']);
    header('Content-Length: ' . filesize($foto['caminho']));
    header('Content-Disposition: inline; filename="ftth-evidencia"');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: private, no-store');
    readfile($foto['caminho']);
    exit;
}

if (isset($_GET['ajax'])) {
    try {
        switch ($_GET['ajax']) {
            case 'ctos_buscar':
                $q = trim((string) ($_GET['q'] ?? ''));
                if (mb_strlen($q) < 2) Resultado::ok(['ctos' => []])->enviar();
                $like = '%' . $q . '%';
                Resultado::ok(['ctos' => Db::todos(
                    'SELECT c.id, c.nome, c.tipo, c.lat, c.lng, r.nome AS regiao
                       FROM tab_ftth_caixa c JOIN tab_ftth_regiao r ON r.id = c.regiao_id
                      WHERE c.excluido_em IS NULL AND c.tipo IN ("CTO","CTO_AP")
                        AND (c.nome LIKE ? OR r.nome LIKE ?)
                      ORDER BY r.nome,c.nome LIMIT 40', [$like, $like])])->enviar();
            case 'ficha':
                $d = Campo::ficha((int) ($_GET['caixa'] ?? 0));
                $d ? Resultado::ok($d)->enviar()
                    : Resultado::erro('FTTH-TOP-001', [], 'CTO não encontrada.')->enviar(404);
            case 'reserva_criar':
                ftth_exigir_csrf();
                $login = trim((string) ($_POST['login'] ?? ''));
                $clienteId = null;
                if ($login !== '') {
                    $c = Db::um('SELECT id FROM sis_cliente WHERE login = ? AND cli_ativado = "s" LIMIT 1', [$login]);
                    if (!$c) Resultado::erro('FTTH-SYS-002', [], 'Não encontrei um cliente ativo com esse login.')->enviar();
                    $clienteId = (int) $c['id'];
                }
                ReservaPorta::criar((int) ($_POST['splitter'] ?? 0), (int) ($_POST['numero'] ?? 0),
                    $clienteId, (string) ($_POST['referencia'] ?? ''), (int) ($_POST['horas'] ?? 24),
                    $usuario_logado)->enviar();
            case 'reserva_cancelar':
                ftth_exigir_csrf();
                ReservaPorta::cancelar((int) ($_POST['id'] ?? 0), $usuario_logado)->enviar();
            case 'medicao':
                ftth_exigir_csrf();
                Campo::medir((int) ($_POST['caixa'] ?? 0), (int) ($_POST['splitter'] ?? 0),
                    (int) ($_POST['numero'] ?? 0), (string) ($_POST['ponto'] ?? 'CTO'),
                    $_POST['dbm'] ?? '', $_POST['lambda'] ?? '', (string) ($_POST['observacao'] ?? ''),
                    $usuario_logado)->enviar();
            case 'foto':
                ftth_exigir_csrf();
                Campo::foto((int) ($_POST['caixa'] ?? 0), $_FILES['foto'] ?? [],
                    (string) ($_POST['legenda'] ?? ''), $usuario_logado)->enviar();
            default: Resultado::erro('FTTH-SYS-002')->enviar(400);
        }
    } catch (Throwable $e) {
        Log::excecao('campo.ajax', $e, ['ajax' => $_GET['ajax'] ?? '', 'caixa_id' => $caixaId]);
        Resultado::erro('FTTH-SYS-001')->enviar(500);
    }
}

include('nav/header.php');
?>
<body>
<?php include('../../topo.php'); ?>
<main class="ftth-wrap ftth-campo-page">
    <div class="ftth-op-topo">
        <div><h1 class="ftth-titulo"><?= $caixaId ? 'Ficha de campo da CTO' : 'Abrir ficha de campo' ?></h1>
            <p class="ftth-sub">Portas, reservas, medições e evidências da planta.</p></div>
        <nav class="ftth-acoes-topo"><a class="ftth-btn ftth-btn--sec" href="mapa.php"><i class="bi-map"></i> Mapa</a>
            <a class="ftth-btn ftth-btn--sec" href="operacao.php">Operação da rede</a></nav>
    </div>
    <?php if (!$caixaId): ?>
        <section class="ftth-card ftth-campo-busca">
            <label for="campo-busca"><strong>Pesquisar CTO</strong></label>
            <input id="campo-busca" class="ftth-campo" placeholder="Digite o nome da CTO ou região" autocomplete="off">
            <div id="campo-ctos" class="ftth-campo-ctos" aria-live="polite"></div>
        </section>
    <?php else: ?>
        <div id="campo-estado" class="ftth-op-status" role="status">Carregando dados da CTO…</div>
        <section class="ftth-card" id="campo-cabecalho" hidden></section>
        <div class="ftth-campo-duas-colunas">
            <section class="ftth-card" id="campo-portas-card" hidden>
                <div class="ftth-card-topo"><h2>Portas e reservas</h2><span id="campo-capacidade" class="ftth-selo ftth-selo--info"></span></div>
                <div id="campo-portas" class="ftth-campo-portas"></div>
                <form id="campo-reserva-form" class="ftth-campo-form" hidden>
                    <h3>Reservar saída <span id="campo-reserva-alvo"></span></h3>
                    <input type="hidden" name="splitter" id="campo-reserva-splitter">
                    <input type="hidden" name="numero" id="campo-reserva-numero">
                    <label>Cliente previsto (login, opcional)<input class="ftth-campo" name="login" maxlength="60"></label>
                    <label>Referência<input class="ftth-campo" name="referencia" maxlength="120" placeholder="Cliente, OS ou motivo"></label>
                    <label>Expira em<select class="ftth-campo" name="horas"><option value="24">24 horas</option><option value="48">48 horas</option><option value="72">72 horas</option><option value="168">7 dias</option></select></label>
                    <div class="ftth-campo-acoes"><button type="button" class="ftth-btn ftth-btn--sec" id="campo-reserva-cancelar">Cancelar</button>
                        <button class="ftth-btn ftth-btn--pri" type="submit">Confirmar reserva</button></div>
                </form>
            </section>
            <section class="ftth-card" id="campo-medicao-card" hidden>
                <div class="ftth-card-topo"><h2>Medição manual de potência</h2></div>
                <p class="ftth-sub">Registre a leitura do medidor. Ela fica identificada como medição manual, separada da estimativa da rota.</p>
                <div id="campo-estimativa" class="ftth-campo-estimativas"></div>
                <form id="campo-medicao-form" class="ftth-campo-form">
                    <label>Valor medido (dBm)<input class="ftth-campo" name="dbm" type="number" min="-100" max="30" step="0.01" required></label>
                    <label>Ponto da leitura<select class="ftth-campo" name="ponto" id="campo-medicao-ponto"><option value="CTO">CTO</option><option value="ENTRADA_CTO">Entrada da CTO (antes do splitter)</option><option value="DROP">DROP</option><option value="ONU">ONU</option><option value="OUTRO">OUTRO</option></select></label>
                    <label>Splitter<select class="ftth-campo" name="splitter" id="campo-medicao-splitter"><option value="0">Não especificado</option></select></label>
                    <label>Saída<input class="ftth-campo" name="numero" id="campo-medicao-numero" type="number" min="1" disabled></label>
                    <label>Comprimento de onda<select class="ftth-campo" name="lambda"><option value="">Não informado</option><option>850</option><option>1270</option><option>1310</option><option>1490</option><option>1550</option><option>1577</option><option>1625</option></select></label>
                    <label>Observação<input class="ftth-campo" name="observacao" maxlength="500"></label>
                    <button class="ftth-btn ftth-btn--pri" type="submit">Salvar medição</button>
                </form>
                <div id="campo-medicoes" class="ftth-campo-registros"></div>
            </section>
        </div>
        <section class="ftth-card" id="campo-fotos-card" hidden>
            <div class="ftth-card-topo"><h2>Fotos de campo</h2><span class="ftth-selo ftth-selo--info">privadas · acesso autenticado</span></div>
            <form id="campo-foto-form" class="ftth-campo-form ftth-campo-foto-form" enctype="multipart/form-data">
                <label>Foto (JPG, PNG ou WebP; máximo 8 MB)<input class="ftth-campo" type="file" name="foto" accept="image/jpeg,image/png,image/webp" required></label>
                <label>Legenda<input class="ftth-campo" name="legenda" maxlength="180"></label>
                <button class="ftth-btn ftth-btn--pri" type="submit">Enviar foto</button>
            </form>
            <div id="campo-fotos" class="ftth-campo-fotos"></div>
        </section>
        <section class="ftth-card" id="campo-etiqueta-card" hidden>
            <div class="ftth-card-topo"><h2>Etiqueta da CTO</h2><button type="button" class="ftth-btn ftth-btn--sec" id="campo-qr-gerar">Gerar QR Code</button></div>
            <p class="ftth-sub">O código abre a ficha autenticada deste addon; o funcionário precisa entrar no MK-Auth.</p>
            <div id="campo-qr" class="ftth-campo-qr" hidden></div>
            <div class="ftth-campo-acoes"><button type="button" class="ftth-btn ftth-btn--sec" id="campo-link-copiar">Copiar link autenticado</button>
                <button type="button" class="ftth-btn ftth-btn--sec" id="campo-imprimir">Imprimir etiqueta</button></div>
        </section>
    <?php endif; ?>
</main>
<script>
window.FTTH_CAMPO = { csrf: <?= json_encode(ftth_csrf_token()) ?>, caixa: <?= $caixaId ?> };
</script>
<script src="js/vendor/qrcode-generator.min.js?v=2.0.4"></script>
<script src="js/campo.js?v=<?= time() ?>"></script>
<?php include('../../baixo.php'); ?>
<script src="../../menu.js<?= $ext_mk ?>"></script>
</body>
</html>
