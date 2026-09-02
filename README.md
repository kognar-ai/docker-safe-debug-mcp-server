<p align="center">
  <img src="https://kognar.com/assets/img/logo_kognar_white.svg" alt="Kognar" width="200" />
</p>

# @kognar/docker-safe-debug-mcp-server

MCP server para **debug remoto de containers Docker** rodando em produção, via **SSH**.

O foco é ser um **safe server**: dar a uma LLM acesso suficiente para investigar as aplicações
em produção, mas com risco estruturalmente baixo de causar um erro catastrófico no ambiente.
Não é uma questão de "pedir para o modelo tomar cuidado" — as operações perigosas simplesmente
**não existem** como ferramentas, e todo comando que roda na máquina é montado pelo servidor a
partir de parâmetros validados (nunca uma string de shell fornecida pelo modelo).

## Por que "safe"?

1. **Read-only por padrão.** Só ferramentas de leitura/inspeção são expostas. Não há `up`, `down`,
   `restart` etc. a menos que você ligue explicitamente `--allow-lifecycle`.
2. **Impossível destruir.** Não existe nenhuma ferramenta que remova/prune/apague container, imagem
   ou volume. O pior caso possível (e só com lifecycle habilitado) é um container parado — nunca
   perda de dados.
3. **Sem injeção de shell.** Toda referência (container/imagem/rede/volume) é validada por regex e
   todo argumento é *single-quoted* antes de chegar no shell remoto. Metacaracteres viram dado
   literal, nunca operador.
4. **`docker exec` sob guarda.** O comando é um `argv` (programa + argumentos), **não** uma string de
   shell — logo não há pipes, redirecionamentos ou encadeamento. Só binários de inspeção read-only
   são permitidos (`cat`, `ls`, `tail`, `grep`, `ps`, `printenv`, `netstat`, `df`, ...). Shells,
   interpretadores e qualquer coisa que escreva/apague estão numa lista de *hard-deny* que **nunca**
   pode ser liberada, nem pelo operador.
5. **Escopo de containers.** Opcionalmente, `--containers` restringe quais containers podem ser
   tocados e `--deny-containers` protege os sensíveis (ex.: bancos de dados).
6. **Limites operacionais.** Timeout por comando, teto de bytes de saída e nenhum `follow`/stream que
   possa travar a sessão.

## Instalação

```bash
npm install
npm run build
```

## Configuração

Aceita via **argumentos de CLI** ou **variáveis de ambiente** (CLI tem precedência).

### Conexão SSH

| flag | env | descrição |
| --- | --- | --- |
| `--host` | `SSH_HOST` | host onde o Docker está rodando **(obrigatório)** |
| `--port` | `SSH_PORT` | porta SSH (default `22`) |
| `--user` | `SSH_USER` | usuário SSH **(obrigatório)** |
| `--private-key` | `SSH_PRIVATE_KEY` | caminho para o arquivo de chave privada |
| `--private-key-data` | `SSH_PRIVATE_KEY_DATA` | chave privada inline (`\n` escapado) |
| `--passphrase` | `SSH_PASSPHRASE` | passphrase da chave |
| `--password` | `SSH_PASSWORD` | autenticação por senha (chave é preferível) |

Sem chave nem senha, o agente SSH local (`$SSH_AUTH_SOCK`) é usado.

### Segurança / comportamento

| flag | env | descrição |
| --- | --- | --- |
| `--allow-lifecycle` | `ALLOW_LIFECYCLE` | habilita `docker_start`/`docker_stop`/`docker_restart` (default off) |
| `--no-exec` | `ALLOW_EXEC=false` | desabilita totalmente o `docker_exec` |
| `--exec-allowlist` | `EXEC_ALLOWLIST` | binários extras para o `docker_exec` (lista separada por vírgula) |
| `--containers` | `ALLOWED_CONTAINERS` | só estes containers podem ser tocados |
| `--deny-containers` | `DENIED_CONTAINERS` | nunca tocar nestes containers (tem precedência) |
| `--use-sudo` | `USE_SUDO` | prefixa os comandos docker com `sudo -n` |
| `--command-timeout` | `COMMAND_TIMEOUT_MS` | timeout por comando em ms (default `30000`) |
| `--max-output` | `MAX_OUTPUT_BYTES` | trunca a saída em N bytes (default `1000000`) |

```bash
npx @kognar/docker-safe-debug-mcp-server \
  --host server.example.com \
  --user debug \
  --private-key ~/.ssh/id_ed25519
```

## Uso com Claude Code / Desktop

Adicione no `claude_desktop_config.json` (ou `.mcp.json`):

```json
{
  "mcpServers": {
    "docker-safe-debug": {
      "command": "npx",
      "args": [
        "-y",
        "@kognar/docker-safe-debug-mcp-server",
        "--host", "server.example.com",
        "--user", "debug",
        "--private-key", "/home/me/.ssh/id_ed25519"
      ]
    }
  }
}
```

Alternativa com variáveis de ambiente (útil para chave inline / lifecycle):

```json
{
  "mcpServers": {
    "docker-safe-debug": {
      "command": "npx",
      "args": ["-y", "@kognar/docker-safe-debug-mcp-server"],
      "env": {
        "SSH_HOST": "server.example.com",
        "SSH_USER": "debug",
        "SSH_PRIVATE_KEY": "/home/me/.ssh/id_ed25519",
        "DENIED_CONTAINERS": "postgres,mysql,vault"
      }
    }
  }
}
```

## Tools disponíveis

**Comece por `debug_ping`** para validar a conexão SSH + daemon Docker, e por `docker_ps` para
descobrir os nomes dos containers.

- **Containers** — `docker_ps`, `docker_inspect`, `docker_logs`, `docker_stats`, `docker_top`,
  `docker_port`, `docker_diff`, `docker_exec` (read-only, sob guarda)
- **Images** — `docker_images`, `docker_image_inspect`, `docker_image_history`
- **Networks** — `docker_networks`, `docker_network_inspect`
- **Volumes** — `docker_volumes`, `docker_volume_inspect`
- **System** — `docker_version`, `docker_info`, `docker_disk_usage`, `docker_events`, `debug_ping`
- **Compose** — `docker_compose_ps`, `docker_compose_logs`, `docker_compose_config`
- **Lifecycle** *(só com `--allow-lifecycle`)* — `docker_start`, `docker_stop`, `docker_restart`

## Recomendação de hardening

Para produção, use um **usuário SSH dedicado e restrito** para o servidor:

- adicione o usuário só ao grupo `docker` (ou configure `sudo -n docker` via `--use-sudo` com uma
  regra `NOPASSWD` restrita ao binário `docker`);
- rode o server sem `--allow-lifecycle` na maior parte do tempo;
- proteja bancos e cofres com `--deny-containers`;
- restrinja a lista de comandos do `docker_exec` ao mínimo necessário.

Mesmo com o grupo `docker` (que é equivalente a root no host), este server não expõe nenhuma
ferramenta capaz de destruir estado — a superfície de ataque fica limitada a leitura/inspeção.

## Desenvolvimento

```bash
npm run dev        # executa via tsx
npm run typecheck  # valida tipos sem emitir
npm test           # testes do modelo de segurança e da construção de comandos
```

O cliente SSH mantém uma conexão única reaproveitada, com reconexão sob demanda; cada comando é
limitado por timeout e a saída capturada é truncada em um teto configurável.

## Licença

[AGPL-3.0](LICENSE)
