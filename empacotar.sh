#!/usr/bin/env bash
#
# ftth_doc :: monta o pacote que as empresas instalam.
#
#   ./empacotar.sh              usa a versao do manifest.json
#   ./empacotar.sh 0.9.1        forca outra versao (nao altera o manifest)
#
# Gera pacote/ftth_doc-<versao>.tar.gz e pacote/SHA256SUMS. O que NAO entra:
#
#   tests/          a suite apaga e recria um banco inteiro — nunca pode chegar a um servidor
#   sql/historico/  as 17 migrations antigas, que existem so para o teste de equivalencia
#   addons.class.php  binario do MK-AUTH; o instalador copia o do proprio servidor
#   uploads/ logs/  pastas vestigiais: o addon grava em /opt/mk-auth/dados e /opt/mk-auth/log
#   .git* empacotar.sh  coisa de desenvolvimento
set -euo pipefail

cd "$(dirname "$0")"

VERSAO="${1:-$(php -r '$m = json_decode(file_get_contents("manifest.json"), true); echo $m["version"] ?? "";' 2>/dev/null || true)}"
if [ -z "$VERSAO" ]; then
    VERSAO=$(grep -o '"version"[^,]*' manifest.json | head -1 | sed 's/.*: *"\{0,1\}//; s/"\{0,1\}$//')
fi
[ -n "$VERSAO" ] || { echo "Nao consegui descobrir a versao (manifest.json)"; exit 1; }

DESTINO="pacote"
NOME="ftth_doc-$VERSAO.tar.gz"

rm -rf "$DESTINO/staging"
mkdir -p "$DESTINO/staging/ftth_doc"

# Copia o addon inteiro e depois remove o que nao vai. Copiar o que fica daria uma lista que
# envelhece a cada arquivo novo; remover o que sai e uma lista que so muda de proposito.
tar cf - \
    --exclude='./tests' \
    --exclude='./sql/historico' \
    --exclude='./pacote' \
    --exclude='./uploads' \
    --exclude='./logs' \
    --exclude='./systemd' \
    --exclude='./.git*' \
    --exclude='./.gitattributes' \
    --exclude='./addons.class.php' \
    --exclude='./empacotar.sh' \
    --exclude='./instalar.sh' \
    --exclude='./README.md' \
    --exclude='*.bak' \
    . | (cd "$DESTINO/staging/ftth_doc" && tar xf -)

# Conferencia: o que nao pode estar la, e o que nao pode faltar.
for proibido in tests sql/historico addons.class.php; do
    if [ -e "$DESTINO/staging/ftth_doc/$proibido" ]; then
        echo "ERRO: $proibido entrou no pacote"; exit 1
    fi
done
for obrigatorio in LICENSE manifest.json config.php mapa.php index.php lib/Schema.php sql/baseline.sql \
                   sql/limpeza.sql cli/schema.php cli/diagnostico.php nav/header.php \
                   css/ftth.css js/mapa.js; do
    if [ ! -e "$DESTINO/staging/ftth_doc/$obrigatorio" ]; then
        echo "ERRO: falta $obrigatorio no pacote"; exit 1
    fi
done

# O asset carrega o addon, o instalador correspondente e os arquivos do auxiliar root-owned.
for obrigatorio in instalar.sh systemd/ftth-doc-update-worker.sh \
                   systemd/ftth-doc-update.cron \
                   systemd/ftth-doc-update.path systemd/ftth-doc-update.service; do
    if [ ! -e "$obrigatorio" ]; then
        echo "ERRO: falta $obrigatorio"; exit 1
    fi
done
cp -p instalar.sh "$DESTINO/staging/instalar.sh"
cp -a systemd "$DESTINO/staging/systemd"
(cd "$DESTINO/staging" && tar czf "../$NOME" ftth_doc instalar.sh systemd)
rm -rf "$DESTINO/staging"
(cd "$DESTINO" && sha256sum "$NOME" > SHA256SUMS)

echo "pacote/$NOME"
echo "$(tar tzf "$DESTINO/$NOME" | wc -l) arquivos, $(du -h "$DESTINO/$NOME" | cut -f1)"
cat "$DESTINO/SHA256SUMS"
