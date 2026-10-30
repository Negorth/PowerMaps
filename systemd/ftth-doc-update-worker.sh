#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
export LC_ALL=C.UTF-8 2>/dev/null || true
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly REPO='Negorth/PowerMaps'
readonly MKAUTH='/opt/mk-auth'
readonly ADDON_DIR="$MKAUTH/admin/addons/ftth_doc"
readonly DATA_DIR="$MKAUTH/dados/ftth_doc"
readonly LOG_DIR="$MKAUTH/log/ftth_doc"
readonly REQUEST_FILE="$DATA_DIR/update.request"
readonly STATUS_FILE="$DATA_DIR/update-status.json"
readonly RUNTIME_DIR='/run/ftth-doc-update'
readonly LOCK_FILE="$RUNTIME_DIR/update.lock"
readonly API_URL="https://api.github.com/repos/$REPO/releases/latest"

TMP=''
LOG_FILE=''
TAG=''
FAIL_MESSAGE='A atualização falhou. Confira o log do instalador no servidor.'

write_status() {
    local state="$1" version="$2" message="$3" temporary
    [[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || return 1
    temporary="$(mktemp "$DATA_DIR/.update-status.XXXXXX")" || return 1
    printf '{"estado":"%s","versao":"%s","atualizado_em":%s,"mensagem":"%s"}\n' \
        "$state" "$version" "$(date +%s)" "$message" > "$temporary"
    chown root:www-data "$temporary"
    chmod 0640 "$temporary"
    mv -fT -- "$temporary" "$STATUS_FILE"
}

log_line() {
    [[ -n "$LOG_FILE" ]] || return 0
    printf '%s %s\n' "$(date '+%F %T')" "$1" >> "$LOG_FILE" 2>/dev/null || true
}

on_exit() {
    local rc=$?
    if (( rc != 0 )); then
        log_line 'Atualização encerrada com falha; detalhes de saída do instalador foram preservados neste log.'
        write_status 'failed' "$TAG" "$FAIL_MESSAGE" 2>/dev/null || true
    fi
    [[ -z "$TMP" ]] || rm -rf -- "$TMP"
}
trap on_exit EXIT

fail() {
    FAIL_MESSAGE="$1"
    log_line "$FAIL_MESSAGE"
    exit 1
}

validar_arquivo() {
    local archive="$1" item line kind
    tar -tzf "$archive" > "$TMP/arquivos.tar" 2>/dev/null \
        || fail 'O pacote da release não é um arquivo tar.gz válido.'

    while IFS= read -r item || [[ -n "$item" ]]; do
        [[ -n "$item" && "$item" != /* && "$item" != *'\'* \
            && "$item" != *$'\r'* && "$item" != *$'\n'* ]] \
            || fail 'O pacote contém um caminho inválido.'
        case "/$item/" in
            *'/../'*|*'/./'*) fail 'O pacote contém um caminho fora da pasta permitida.' ;;
        esac
        case "$item" in
            ftth_doc|ftth_doc/*|systemd|systemd/*|instalar.sh) ;;
            *) fail 'O pacote contém arquivos fora da estrutura esperada.' ;;
        esac
    done < "$TMP/arquivos.tar"

    tar -tvzf "$archive" > "$TMP/detalhes.tar" 2>/dev/null \
        || fail 'Não foi possível inspecionar os tipos de arquivo da release.'
    while IFS= read -r line || [[ -n "$line" ]]; do
        kind="${line:0:1}"
        [[ "$kind" == 'd' || "$kind" == '-' ]] \
            || fail 'O pacote contém link ou tipo de arquivo não permitido.'
    done < "$TMP/detalhes.tar"

    for item in 'ftth_doc/manifest.json' 'ftth_doc/LICENSE' 'instalar.sh' \
                'systemd/ftth-doc-update-worker.sh' 'systemd/ftth-doc-update.cron' \
                'systemd/ftth-doc-update.path' \
                'systemd/ftth-doc-update.service'; do
        grep -Fxq "$item" "$TMP/arquivos.tar" \
            || fail 'O pacote não contém os arquivos obrigatórios do atualizador.'
    done
}

versao_do_pacote() {
    tar -xOf "$1" ftth_doc/manifest.json 2>/dev/null \
        | php -r '$m = json_decode(stream_get_contents(STDIN), true); echo is_array($m) ? ($m["version"] ?? "") : "";'
}

[[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] \
    || { FAIL_MESSAGE='A pasta de dados do addon não está disponível.'; exit 1; }
[[ -d "$LOG_DIR" && ! -L "$LOG_DIR" ]] \
    || { FAIL_MESSAGE='A pasta de logs do addon não está disponível.'; exit 1; }
[[ ! -L "$RUNTIME_DIR" ]] \
    || { FAIL_MESSAGE='A pasta de execução do auxiliar está inválida.'; exit 1; }
install -d -o root -g root -m 0750 "$RUNTIME_DIR" \
    || { FAIL_MESSAGE='Não foi possível preparar a pasta de execução do auxiliar.'; exit 1; }
[[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]] \
    || { FAIL_MESSAGE='A pasta de execução do auxiliar está inválida.'; exit 1; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    exit 0
fi

if [[ ! -e "$REQUEST_FILE" && ! -L "$REQUEST_FILE" ]]; then
    exit 0
fi
if [[ -L "$REQUEST_FILE" || ! -f "$REQUEST_FILE" ]]; then
    rm -f -- "$REQUEST_FILE"
    FAIL_MESSAGE='O pedido de atualização estava inválido e foi descartado.'
    exit 1
fi

REQUEST_TIME="$(stat -c %Y -- "$REQUEST_FILE" 2>/dev/null || echo 0)"
NOW="$(date +%s)"
if (( REQUEST_TIME < 1 || REQUEST_TIME > NOW + 60 || NOW - REQUEST_TIME > 300 )); then
    rm -f -- "$REQUEST_FILE"
    FAIL_MESSAGE='O pedido de atualização expirou. Solicite novamente pelo painel.'
    exit 1
fi

install -d -o root -g www-data -m 0750 "$LOG_DIR"
LOG_FILE="$LOG_DIR/atualizacao-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG_FILE"
chown root:www-data "$LOG_FILE"
chmod 0640 "$LOG_FILE"
TMP="$(mktemp -d /tmp/ftth-doc-update.XXXXXXXX)"

# A condição em estado é publicada antes de remover o pedido: o painel não abre uma janela
# em que um segundo clique consiga criar outro trabalho.
write_status 'running' '' 'Consultando e validando a release oficial.' \
    || fail 'Não foi possível publicar o estado da atualização.'
rm -f -- "$REQUEST_FILE"
log_line 'Consultando a release estável do repositório oficial.'

command -v curl >/dev/null 2>&1 || fail 'O servidor não tem curl para consultar a release.'
command -v php >/dev/null 2>&1 || fail 'O servidor não tem PHP CLI para validar a release.'
command -v sha256sum >/dev/null 2>&1 || fail 'O servidor não tem sha256sum para validar o pacote.'

curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 30 \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    --header 'User-Agent: PowerMaps-FTTH-Doc-Updater' \
    "$API_URL" -o "$TMP/release.json" \
    || fail 'Não foi possível consultar a release no GitHub.'

META="$(php -r '
$j = json_decode(file_get_contents($argv[1]), true);
if (!is_array($j) || !empty($j["draft"]) || !empty($j["prerelease"])) exit(2);
$tag = (string) ($j["tag_name"] ?? "");
if (!preg_match("/^v([0-9]+\\.[0-9]+\\.[0-9]+)$/", $tag, $m)) exit(3);
$name = "ftth_doc-" . $m[1] . ".tar.gz";
foreach (($j["assets"] ?? []) as $asset) {
    if (($asset["name"] ?? "") === $name) {
        $digest = (string) ($asset["digest"] ?? "");
        if (!preg_match("/^sha256:[a-f0-9]{64}$/i", $digest)) exit(4);
        echo $tag, "\t", strtolower($digest);
        exit(0);
    }
}
exit(5);
' "$TMP/release.json" 2>/dev/null)" \
    || fail 'A release não tem tag estável, pacote esperado e digest SHA-256 válidos.'

IFS=$'\t' read -r TAG DIGEST <<< "$META"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || fail 'Os metadados da release estão malformados.'
VERSION="${TAG#v}"

CURRENT="$(php -r '
$m = @json_decode(@file_get_contents($argv[1]), true);
echo is_array($m) ? ($m["version"] ?? "") : "";
' "$ADDON_DIR/manifest.json" 2>/dev/null || true)"
[[ "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail 'Não foi possível identificar a versão instalada do addon.'
LATEST_SORTED="$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -n 1)"
if [[ "$LATEST_SORTED" != "$VERSION" || "$CURRENT" == "$VERSION" ]]; then
    write_status 'succeeded' "v$CURRENT" 'O addon já está na versão mais recente.' \
        || fail 'Não foi possível publicar o estado final.'
    exit 0
fi

write_status 'running' "$TAG" 'Baixando o pacote da release.' \
    || fail 'Não foi possível publicar o estado da atualização.'
PACKAGE="$TMP/ftth_doc-$VERSION.tar.gz"
PACKAGE_URL="https://github.com/$REPO/releases/download/$TAG/ftth_doc-$VERSION.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --max-time 300 --output "$PACKAGE" "$PACKAGE_URL" \
    || fail 'Não foi possível baixar o pacote da release.'

ACTUAL_DIGEST="sha256:$(sha256sum "$PACKAGE" | awk '{print $1}')"
[[ "$ACTUAL_DIGEST" == "$DIGEST" ]] \
    || fail 'O digest do pacote não corresponde ao publicado pelo GitHub.'
validar_arquivo "$PACKAGE"
PACKAGE_VERSION="$(versao_do_pacote "$PACKAGE")"
[[ "$PACKAGE_VERSION" == "$VERSION" ]] \
    || fail 'A versão do manifest do pacote não corresponde à tag da release.'

write_status 'running' "$TAG" 'Instalando a versão validada e aplicando as migrações.' \
    || fail 'Não foi possível publicar o estado da atualização.'
tar -xOf "$PACKAGE" instalar.sh > "$TMP/instalar.sh" 2>/dev/null \
    || fail 'Não foi possível extrair o instalador oficial da release.'
chmod 0700 "$TMP/instalar.sh"

# O ambiente do serviço é reconstruído: valores como FTTH_REPO, GITHUB_TOKEN ou senhas não
# são herdados pelo instalador. As credenciais existentes são lidas pelo caminho habitual.
if ! env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    FTTH_UPDATE_WORKER=1 \
    /bin/bash "$TMP/instalar.sh" "--pacote=$PACKAGE" --nao-interativo \
    > "$LOG_FILE" 2>&1; then
    fail 'O instalador não concluiu. Confira o log e o backup antes de tentar novamente.'
fi

INSTALLED="$(php -r '
$m = @json_decode(@file_get_contents($argv[1]), true);
echo is_array($m) ? ($m["version"] ?? "") : "";
' "$ADDON_DIR/manifest.json" 2>/dev/null || true)"
[[ "$INSTALLED" == "$VERSION" ]] \
    || fail 'O instalador terminou, mas a versão instalada não corresponde à release validada.'

log_line "Atualização concluída para v$INSTALLED."
write_status 'succeeded' "v$INSTALLED" 'Atualização concluída.' \
    || fail 'A instalação terminou, mas não foi possível publicar o estado final.'
exit 0
