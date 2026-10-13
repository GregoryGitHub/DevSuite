//! Tipos neutros e contrato dos drivers de banco de dados.
//!
//! O frontend não sabe qual banco está do outro lado: recebe colunas/células neste formato e
//! o `dialect` da conexão (quoting, paginação, literais), definido em `src/js/utils/sqlDialect.js`.
//! Um banco novo (Postgres, MySQL, SQLite...) só precisa implementar [`Driver`] e [`Session`].

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type DbResult<T> = Result<T, String>;

/// Configuração de uma conexão como salva em `databases.json` (sem segredos).
#[derive(Deserialize, Clone, Debug)]
pub struct ConnConfig {
    pub id: String,
    #[serde(default = "default_driver")]
    pub driver: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    /// Instância nomeada do SQL Server (`SERVIDOR\INSTANCIA`), resolvida pelo SQL Browser.
    #[serde(default)]
    pub instance: Option<String>,
    #[serde(default)]
    pub database: String,
    pub auth: AuthConfig,
    /// "on" | "strict" | "off"
    #[serde(default = "default_encrypt")]
    pub encrypt: String,
    #[serde(default)]
    pub trust_server_certificate: bool,
    /// ApplicationIntent=ReadOnly (réplicas de leitura do Azure).
    #[serde(default)]
    pub read_intent: bool,
    #[serde(default = "default_timeout")]
    pub connect_timeout_s: u64,
    /// MongoDB: connection string (mongodb:// ou mongodb+srv://) sem a senha (que fica no cofre).
    #[serde(default)]
    pub uri: String,
    /// MongoDB: aceitar certificado TLS inválido/autoassinado.
    #[serde(default)]
    pub tls_insecure: bool,
}

fn default_driver() -> String {
    "mssql".into()
}

fn default_encrypt() -> String {
    "on".into()
}

fn default_timeout() -> u64 {
    15
}

#[derive(Deserialize, Clone, Debug)]
pub struct AuthConfig {
    /// "sql" (usuário/senha) | "entra" (Microsoft Entra interativo/MFA)
    pub kind: String,
    #[serde(default)]
    pub user: String,
    /// Entra: tenant (id ou domínio); vazio = "organizations".
    #[serde(default)]
    pub tenant: String,
    /// Entra: client id público; vazio = padrão de `entra.rs`.
    #[serde(default)]
    pub client_id: String,
}

/// Segredo já resolvido para abrir a conexão.
pub enum Secret {
    Password(String),
    AccessToken(String),
}

/// Coluna de um resultado.
#[derive(Serialize, Clone, Debug)]
pub struct ColumnMeta {
    pub name: String,
    /// Nome do tipo no banco ("int", "nvarchar", "datetime2"...).
    #[serde(rename = "type")]
    pub type_name: String,
    /// Classe usada pelo grid: "int" | "num" | "dec" | "bool" | "str" | "date" | "time" | "datetime" | "guid" | "bin" | "xml" | "other"
    pub kind: &'static str,
}

/// Eventos enviados ao frontend durante uma execução (via `tauri::ipc::Channel`).
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecEvent {
    /// Começo de um result set.
    ResultStart { index: usize, columns: Vec<ColumnMeta> },
    /// Lote de linhas (cada linha é um array na ordem das colunas).
    Rows { index: usize, rows: Vec<Vec<Value>> },
    /// Lote de documentos (bancos de documentos) em Extended JSON relaxado.
    Docs { index: usize, docs: Vec<Value> },
    /// Fim de um result set.
    ResultEnd { index: usize, row_count: u64, truncated: bool },
}

/// Resumo devolvido pelo comando de execução.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ExecSummary {
    pub result_sets: usize,
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
    /// Transações abertas na sessão ao terminar (@@TRANCOUNT).
    pub tran_count: u32,
    pub truncated: bool,
}

/// Recebe os eventos de uma execução (o comando Tauri repassa para o Channel).
pub trait EventSink: Send {
    fn send(&mut self, event: ExecEvent) -> DbResult<()>;
}

/// Caminho de um nó do Database Explorer.
#[derive(Deserialize, Clone, Debug)]
pub struct ObjectPath {
    /// "databases" | "schemas" | "schema" | "table" | "view" | "procedure" | "function"
    pub kind: String,
    #[serde(default)]
    pub schema: String,
    #[serde(default)]
    pub name: String,
}

/// Nó do Database Explorer.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ObjectNode {
    /// "database" | "schema" | "table" | "view" | "procedure" | "function" | "column" | "key" | "index" | "fk" | "trigger"
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub schema: String,
    /// Texto secundário (tipo da coluna, colunas do índice...).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// Marca extra: banco atual, coluna PK, índice único...
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub flag: bool,
    /// Linhas aproximadas (tabelas).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<i64>,
}

/// Coluna de uma tabela, para o grid editável.
#[derive(Serialize, Clone, Debug, Default)]
pub struct TableColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    /// Tipo completo para exibição ("nvarchar(200)", "decimal(18,2)").
    pub full_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub is_identity: bool,
    pub is_computed: bool,
    pub has_default: bool,
    /// Destino da FK ("schema.tabela.coluna").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fk: Option<FkTarget>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FkTarget {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// "table" | "view"
    pub kind: String,
    pub columns: Vec<TableColumn>,
    pub row_estimate: Option<i64>,
}

/// Estrutura completa de uma tabela para o diálogo "Modificar tabela" (o frontend gera o DDL).
#[derive(Serialize, Clone, Debug, Default)]
pub struct TableSchema {
    pub schema: String,
    pub name: String,
    pub columns: Vec<SchemaColumn>,
    pub indexes: Vec<SchemaIndex>,
    pub fks: Vec<SchemaFk>,
    pub checks: Vec<SchemaCheck>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SchemaColumn {
    pub name: String,
    /// Tipo completo ("nvarchar(200)", "decimal(18,2)").
    #[serde(rename = "type")]
    pub full_type: String,
    pub nullable: bool,
    pub identity: bool,
    pub seed: i64,
    pub increment: i64,
    /// Expressão da coluna calculada (vazio = coluna comum).
    pub computed: String,
    /// Expressão do DEFAULT como o banco guarda ("((0))", "(getdate())").
    pub default: String,
    /// Nome da constraint de DEFAULT (para trocá-la ou remover a coluna).
    pub default_name: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct IndexColumn {
    pub name: String,
    pub desc: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SchemaIndex {
    pub name: String,
    /// "pk" | "unique" (constraint) | "uindex" (índice único) | "index" | "other" (columnstore, XML, espacial...)
    pub kind: String,
    pub clustered: bool,
    pub columns: Vec<IndexColumn>,
    pub include: Vec<String>,
    pub filter: String,
    /// Tipo como o banco descreve ("NONCLUSTERED COLUMNSTORE"...).
    pub type_desc: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SchemaFk {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    /// "NO ACTION" | "CASCADE" | "SET NULL" | "SET DEFAULT"
    pub on_delete: String,
    pub on_update: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SchemaCheck {
    pub name: String,
    pub definition: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ServerInfo {
    pub product: String,
    pub version: String,
    pub database: String,
    pub user: String,
    /// "mssql": dialeto SQL usado pelo frontend.
    pub dialect: String,
}

/// Uma conexão aberta. Os métodos recebem `&mut self`: uma requisição por vez por sessão.
#[async_trait]
pub trait Session: Send {
    async fn server_info(&mut self) -> DbResult<ServerInfo>;

    /// Executa um comando na linguagem da conexão (SQL; no MongoDB, a operação em JSON montada
    /// pelo frontend a partir da sintaxe do mongosh) enviando os resultados para `sink`.
    /// `max_rows` limita as linhas de cada result set (o resto é cancelado no servidor).
    async fn execute(&mut self, sql: &str, sink: &mut dyn EventSink, max_rows: Option<u64>) -> DbResult<ExecSummary>;

    /// Chamado depois que o future de `execute` foi descartado no meio da resposta.
    /// A sessão deve se marcar como quebrada se não puder ser reaproveitada com segurança.
    async fn cancel(&mut self);

    /// A conexão caiu ou ficou dessincronizada: deve ser descartada e reaberta.
    fn is_broken(&self) -> bool;

    /// Executa vários comandos como uma unidade e devolve as linhas afetadas de cada um.
    /// Se `atomic`, roda numa transação própria (tudo ou nada).
    async fn apply(&mut self, statements: &[String], atomic: bool) -> DbResult<Vec<u64>>;

    async fn introspect(&mut self, path: &ObjectPath) -> DbResult<Vec<ObjectNode>>;
    async fn table_info(&mut self, schema: &str, name: &str) -> DbResult<TableInfo>;
    async fn ddl(&mut self, path: &ObjectPath) -> DbResult<String>;

    /// Estrutura editável da tabela (colunas, índices, FKs, checks). Bancos sem DDL editável
    /// (MongoDB) ficam com o padrão.
    async fn table_schema(&mut self, _schema: &str, _name: &str) -> DbResult<TableSchema> {
        Err("Edição de estrutura não disponível para este banco".into())
    }

    async fn begin(&mut self) -> DbResult<u32>;
    async fn commit(&mut self) -> DbResult<u32>;
    async fn rollback(&mut self) -> DbResult<u32>;

    async fn close(self: Box<Self>);
}

#[async_trait]
pub trait Driver: Send + Sync {
    async fn connect(&self, cfg: &ConnConfig, database: &str, secret: Secret) -> DbResult<Box<dyn Session>>;
}

/// Driver pelo nome salvo na conexão.
pub fn driver_for(name: &str) -> DbResult<&'static dyn Driver> {
    match name {
        "mssql" | "azuresql" => Ok(&super::mssql::MssqlDriver),
        "mongo" => Ok(&super::mongo::MongoDriver),
        other => Err(format!("Driver de banco não suportado: {other}")),
    }
}
