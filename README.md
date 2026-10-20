<div align="center">

# ⚡ Dev Suite

**Um aplicativo de produtividade desktop moderno, ultraleve e minimalista.**  
*Organize suas tarefas num board kanban, capture notas rápidas e mantenha o foco com o Timer Pomodoro integrado.*

[![Tauri v2](https://img.shields.io/badge/Tauri-v2.0-blue?logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-yellow?logo=javascript&logoColor=black)](https://developer.mozilla.org/pt-BR/docs/Web/JavaScript)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## ✨ Recursos Principais

- 🗂️ **Board Kanban**: Vários boards com colunas editáveis (status, cor, limite WIP), cards com prazo, etiquetas e anotação, arrastar e soltar, filtros e arquivados.
- ⏱️ **Pomodoro nos cards**: ▶ no card inicia o foco (e leva o card para "Fazendo"); barra de foco com pausa, pausa longa e contagem de 🍅 e tempo focado por card.
- 📝 **Notas Rápidas**: Crie, edite e organize anotações rápidas em um grid visual intuitivo.
- 🪟 **Janela Frameless & System Tray**: Interface limpa sem bordas de sistema, com suporte a minimizar para a bandeja do sistema (System Tray).
- ⚙️ **Configurações de Sistema**: Opções para iniciar junto com o sistema operacional e iniciar minimizado na bandeja.

---

## 🛠️ Tecnologias Utilizadas

- **Frontend**: HTML5, CSS3 Vanilla (com variáveis CSS e temas escuros elegantes), JavaScript Nativo (ES Modules).
- **Backend / Desktop Frame**: [Rust](https://www.rust-lang.org/) + [Tauri v2](https://tauri.app/).
- **Ícones**: [FontAwesome 6](https://fontawesome.com/).
- **Tipografia**: [Google Fonts - Poppins](https://fonts.google.com/specimen/Poppins).

---

## 📂 Arquitetura do Projeto

O código do frontend é totalmente desacoplado em módulos ES sem dependências pesadas de frameworks:

```
todo-rs/
├── .github/workflows/         # Automação CI/CD para compilação e publicação automática
├── src/                       # Interface Frontend
│   ├── index.html             # Estrutura HTML principal
│   ├── styles.css             # Estilos globais e temas
│   ├── main.js                # Orquestrador principal do app
│   └── js/                    # Módulos JS por responsabilidade
│       ├── api.js             # Chamadas IPC Tauri
│       ├── state.js           # Estado global reativo
│       ├── utils/             # Utilitários de data e áudio
│       └── components/        # Componentes UI (tasks, notes, pomodoro, settings, etc.)
├── src-tauri/                 # Backend Rust (Tauri)
│   ├── tauri.conf.json        # Configuração da aplicação e empacotamento
│   └── src/main.rs            # Comandos Rust e persistência de dados em disco
├── build_linux.sh             # Script de release para Linux (.deb, .rpm, .AppImage)
├── build_windows.ps1          # Script de release para Windows (.exe, .msi)
├── clean.sh                   # Script de limpeza de cache de build
└── AGENTS.md                  # Guia de contexto da arquitetura para IAs
```

---

## 🚀 Como Executar Localmente

### Pré-requisitos
- [Rust](https://www.rust-lang.org/tools/install) instalado.
- [Node.js](https://nodejs.org/) (opcional, apenas para gerenciadores de pacote se desejado).
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/setup/):
  ```bash
  cargo install tauri-cli --version '^2.0' --locked
  ```

### Modo Desenvolvimento

Para rodar a aplicação em modo de desenvolvimento com live-reload:

```bash
cargo tauri dev
```

---

## 📦 Gerando Builds de Release

### Linux (`.deb`, `.rpm`, `.AppImage`)
Execute o script de build para Linux:
```bash
./build_linux.sh
```
Os executáveis e pacotes gerados estarão em `src-tauri/target/release/bundle/`.

### Windows (`.exe`, `.msi`)
No PowerShell no Windows, execute:
```powershell
.\build_windows.ps1
```
Os arquivos gerados estarão em `src-tauri\target\release\bundle\`.

---

## 🧹 Limpeza de Cache de Build

Arquivos de compilação intermediários gerados pelo Rust podem ser limpos a qualquer momento com:

- **Linux**: `./clean.sh`
- **Windows**: `.\clean.ps1`

---

## 📄 Licença

Este projeto está sob a licença [MIT](LICENSE).
