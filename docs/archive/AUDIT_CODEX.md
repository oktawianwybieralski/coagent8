# Audyt CoAgent8 przed RC 1 / Beta 1

**Data:** 3 października 2026, Europe/Warsaw. **Werdykt:** wydanie z deklarowaną obsługą Codex CLI + Gemini CLI jest obecnie zablokowane.

Obecne testy przechodzą w 100%: **20/20 na Windows, zarówno Node 22.20.0, jak i Node 20.20.2**. Paczka z lokalnego tarballa instaluje się i poprawnie uruchamia MCP. Nie oznacza to pełnego pokrycia ani gotowości produktu: Gemini nie wykonuje zadań, część komunikacji z Codex jest niezgodna z CLI, a obsługa procesów i sesji ma odtworzone błędy.

## 1. Zakres, metodologia i granice ustaleń

Audyt obejmuje wszystkie **33 pliki w `src/`**, **5 plików w `test/`**, README, `docs/PLAN_V1.0.0.md`, manifesty, lockfile, konfigurację TypeScript, skrypt polyfill, CI oraz reguły `.agents/`. Sprawdzono również zawartość `dist/`, opakowanie npm, obecność punktów wejścia i zasobów.

- Punktem odniesienia jest commit `ec1940c5e72dbde7e94c404e8050c306eb67058e` oraz zastany working tree, zawierający niezapisane zmiany w 8 plikach. Numery linii odnoszą się do tego working tree.
- Raport powstaje na gałęzi `chore/audit-rc1-codex-20261003`. Audyt nie wprowadza poprawek produkcyjnych.
- Zastane pliki `dist/index.cjs` i `dist/index.cjs.map` zachowano i przywrócono po zbudowaniu paczki. Zweryfikowano zgodność ich hashy przed i po próbach.
- Sprawdzono statycznie przepływy oraz dynamicznie wybrane błędy, wykorzystując syntetyczne subprocessy, izolowane pliki sesji i klienta MCP. Reprodukcje nie wysyłały kodu do modeli.
- Lokalny Codex CLI: **0.160.0**, dostępny jako natywne `.exe`. Gemini i Claude nie były dostępne w lokalnym PATH. Nie wykonano płatnych generacji ani rzeczywistej rozmowy wieloturowej z providerami.
- Dokumentację CLI i SDK pobrano przez Context7. Sporne zachowania porównano z oficjalną dokumentacją i lokalnym `--help`; dla Gemini odczytano również oficjalne typy zdarzeń.
- Nie uruchomiono zdalnej macierzy GitHub Actions ani testów na Ubuntu/macOS. Lokalny wynik nie jest potwierdzeniem `6/6` CI.

**Priorytety w raporcie:** P0 - blokuje podstawowy cel wydania; P1 - istotny błąd bezpieczeństwa, poprawności albo niezawodności do naprawy przed wydaniem; P2 - dług, odporność lub spójność wymagająca uporządkowania. Zgodnie z [regułą author-reviewer](.agents/rules/author-reviewer.md) również ustalenia P2 wymagają remediacji przed scaleniem PR do `main`.

## 2. Weryfikacja wykonana podczas audytu

| Kontrola | Wynik | Co rzeczywiście potwierdza |
| --- | --- | --- |
| `npm run typecheck`, Node 22 | PASS, 0 błędów | Kompilację obecnych typów; `any` ogranicza siłę tej kontroli |
| `npm run build`, Node 22 | PASS, 54 ms | Generowanie CJS i source map |
| `npm test`, Node 22 | PASS, 20/20, bez skipped/todo | Obecny zestaw testów |
| `npm pack --dry-run --json` | PASS, 42 pliki | Listę plików paczki, bez `node_modules/`, testów i reguł deweloperskich |
| Rzeczywisty `npm pack` | PASS | Tarball `coagent8-0.9.0-dev.tgz`: 229 412 B, po rozpakowaniu 637 529 B |
| Instalacja tarballa w osobnym katalogu | PASS | Runtime wraz z zależnościami instaluje się bez devDependencies CoAgent8 |
| MCP z zainstalowanego tarballa | PASS | Handshake, wersję `0.9.0-dev`, `tools/list`: 22 narzędzia, wybrane `tools/call` |
| Node 20.20.2: typecheck i testy | PASS, 20/20 | Te same kontrole przy użyciu narzędzi z obecnego `node_modules/` |
| Node 20.20.2: build w kopii źródeł | PASS, 145 ms | Obecny bundler działa w tej próbie z polyfillem; nie potwierdza oficjalnego wsparcia Node 20 przez bundler |
| Node 20.20.2: zainstalowany tarball i MCP | PASS | Działający runtime na tej wersji Node |
| `npm audit --omit=dev --json` | 0 zgłoszonych podatności | Wynik rejestru advisories dla zależności runtime w chwili audytu |
| `npm view coagent8 version dist-tags engines bin --json` | **E404** | Publiczna instalacja pod nazwą `coagent8` nie była dostępna w użytym rejestrze npm |
| `git diff --check` | 2 zastane uwagi formatowania | Dodatkowe puste linie na EOF w `docs/PLAN_V1.0.0.md:302` i `plugin.json:32`; pozostawiono zmiany użytkownika |

W instalacji tarballa sprawdzono banner na stderr, poprawny handshake bez zanieczyszczenia stdout oraz zamknięcie bezczynnego procesu po EOF stdin. Nie potwierdzono zamykania procesu i jego potomków po odłączeniu klienta w trakcie aktywnej generacji.

Node 20 uruchomiono jako izolowane narzędzie audytowe. Nie wykonywano ponownego `npm ci` całego projektu pod Node 20; ten etap oraz wszystkie 6 kombinacji OS/Node pozostają kontrolami CI.

## 3. Rejestr ustaleń

| ID | Priorytet | Ustalenie | Dowód / główne miejsce |
| --- | --- | --- | --- |
| F01 | P0 | Gemini jest atrapą i nie uczestniczy w routingu ani publicznym kontrakcie wykonania | `gemini.adapter.ts:42`, `router.service.ts:33`, `server.ts:42` |
| F02 | P0 | Standardowe instalacje CLI przez npm na Windows nie mają obsługi shimów `.cmd` | `process.service.ts:110`, `codex.adapter.ts:22`; reprodukcja `spawn EINVAL` |
| F03 | P0 | Natywna ścieżka `codex_review_code` przekazuje nieobsługiwaną flagę `-m` | `review.tool.ts:159,223`, `codex.adapter.ts:534`; CLI zwraca exit 2 |
| F04 | P0 | Udokumentowana publiczna instalacja npm nie jest jeszcze dostępna | `README.md:122`, `package.json:4`; zapytanie npm E404 |
| F05 | P1 | Pre-aborted request może pozostawić subprocess bez listenera `error` i wywołać uncaught ENOENT | `process.service.ts:134`, `claude.adapter.ts:117`; reprodukcja |
| F06 | P1 | Adaptery wykonawcze nie mają deadline, a teardown nie gwarantuje zakończenia drzewa | `codex.adapter.ts:392`, `claude.adapter.ts:105`, `process.service.ts:18,35` |
| F07 | P1 | Błąd protokołu przy exit 0 jest raportowany jako sukces | `codex.adapter.ts:234,497`; odtworzone `turn.failed` → `isError: false` |
| F08 | P1 | Ograniczenia pamięci można ominąć plikiem wyniku i pełną długą linią JSONL | `codex.adapter.ts:265,484`; odpowiedź 2 MiB bez ograniczenia |
| F09 | P1 | Reclaim locka może usunąć świeżą blokadę innego właściciela | `session.service.ts:153-174`; kontrolowany interleaving potwierdza utratę locka |
| F10 | P1 | Locki blokują event loop; uszkodzony stary lock bez tokena nie jest odzyskiwany | `session.service.ts:85,113,160`; próba trwała 13,2 s |
| F11 | P1 | Rekordy sesji nie mają walidacji schematu; mutacje i expiry nie są objęte jednolitą blokadą | `session.service.ts:55,399,432`; niepoprawna data i alias uchwytu zaakceptowane |
| F12 | P2 | Brak jawnego unieważniania natywnej sesji i oddzielnej polityki retencji providera | `session.service.ts:453`, `consult.tool.ts:177` |
| F13 | P1 | Redakcja obejmuje raport błędu, ale surowy błąd nadal trafia do odpowiedzi MCP | `server.ts:254`, `common.ts:16`; syntetyczny sekret widoczny w odpowiedzi |
| F14 | P1 | Governance rozpoznaje tylko kilka dokładnych aliasów modeli | `policy.service.ts:3,17`; `gpt-6-astra` bez zgody nie jest blokowane |
| F15 | P1 | Parametry narzędzi MCP, walidacja runtime i TypeScript rozchodzą się | `server.ts:44,157`, `config.tool.ts:13`, `config.service.ts:21` |
| F16 | P1 | `CliAdapter` nie steruje wykonaniem; handlery nadal wybierają Codex/Claude ręcznie | `review.tool.ts:137,189`, `consult.tool.ts:135,168`, `analyze.tool.ts:140,173` |
| F17 | P2 | Migracja konfiguracji, sesji i quota jest niespójna; `routing.strategy` pozostaje martwe | `config.service.ts:109,139`, `session.service.ts:14`, `quota.service.ts:10` |
| F18 | P2 | Doctor utożsamia instalację z gotowością i podaje domyślny backend niezależnie od konfiguracji | `doctor.service.ts:13,43`, `gemini.adapter.ts:27` |
| F19 | P2 | Quota to cooldown, a nie pomiar 5h; cache ma luki współbieżności, ranking obejmuje najwyżej 2 kandydatów | `quota.service.ts:56,87,243`, `quota.tool.ts:7` |
| F20 | P2 | Progress nie rozpoznaje rzeczywistego `command_execution` i może się cofnąć | `codex.adapter.ts:101`, `progress.service.ts:47`; odtworzone `[101,100]` |
| F21 | P2 | Git scope nie gwarantuje kompletnego snapshotu nowych plików ani spójnego zakresu w podkatalogu | `git.service.ts:66,81`, `review.tool.ts:143` |
| F22 | P2 | Release metadata, roadmap i deklaracja standalone bundle nie odpowiadają artefaktowi | `package.json:4,38`, `docs/PLAN_V1.0.0.md:164,264`, `dist/index.cjs:24` |
| F23 | P2 | Toolchain oficjalnie wymaga nowszego Node niż macierz projektu; typy Node 26 nie pilnują API Node 20 | `package.json:33,61`, metadata `tsdown@0.23.0` |
| F24 | P1 | Zestaw testów pomija krytyczne ścieżki wykonania, protokół MCP i instalację | cały `test/`, szczegółowa macierz w sekcji 8 |
| F25 | P2 | Rebranding pozostawia stare typy, logi, aktywne ścieżki i komunikaty | 116 pasujących linii w 25 plikach, inwentaryzacja poniżej |

F04 jest warunkiem dystrybucji wydania, a nie błędem algorytmu. Brak publikacji jest zrozumiały na etapie development, ale README obecnie opisuje niedostępną ścieżkę instalacji jako działającą.

## 4. Dług nazewnictwa: Omni → Syn

### 4.1. Pełna inwentaryzacja plików źródłowych i metadanych

Skan `rg -n -i --hidden ... 'omni'` poza `.git/`, `node_modules/` i wygenerowanym `dist/` wykazał **116 linii w 25 plikach**. Liczba obejmuje świadomą kompatybilność, zwykłe komentarze i rzeczywisty dług. W wygenerowanym bundlu oraz jego source map pozostają kopie części tych wpisów.

| Plik i linie | Pozostałość | Zalecenie |
| --- | --- | --- |
| [src/types/config.types.ts](src/types/config.types.ts):9 | `OmniAgentConfig` | Zmienić na `CoAgent8Config`; deprecated alias tylko jeśli istnieje wspierany odbiorca tego typu |
| [src/services/config.service.ts](src/services/config.service.ts):4,24,42,109,137,160 | Import, typy zwrotne i `Partial<OmniAgentConfig>` | Zmienić wewnętrzne użycia razem z interfejsem |
| `config.service.ts:112` | `OMNIAGENT_CONFIG` w warunku legacy fallback | Zachować fallback, korzystać z centralnych stałych |
| [src/services/router.service.ts](src/services/router.service.ts):52,108-109,122-123,140,160 | `omniagent_doctor`, `omniagent_set_default`, marka OmniAgent w aktywnych błędach | Nowe komunikaty kierować do `coagent8_*` i CoAgent8 |
| [src/adapters/gemini.adapter.ts](src/adapters/gemini.adapter.ts):45 | `Use omniagent_doctor` w błędzie atrapy | Zastąpić podczas wdrożenia adaptera |
| [src/tools/review.tool.ts](src/tools/review.tool.ts):208 | `[OmniAgent]` w logu zwalniania sesji | Używać centralnego loggera i `BRAND.NAME` |
| [src/tools/consult.tool.ts](src/tools/consult.tool.ts):187 | `[OmniAgent]` | Jak wyżej |
| [src/tools/analyze.tool.ts](src/tools/analyze.tool.ts):192 | `[OmniAgent]` | Jak wyżej |
| [src/services/process.service.ts](src/services/process.service.ts):51 | OmniAgent w komentarzu | Zaktualizować komentarz |
| [src/services/quota.service.ts](src/services/quota.service.ts):10 | `OMNIAGENT_QUOTA_CACHE`, aktywny domyślny katalog `.omniagent` | Wprowadzić `coagent8_QUOTA_CACHE` i nową lokalizację; legacy wyłącznie fallback |
| [src/services/session.service.ts](src/services/session.service.ts):25-26 | `OMNIAGENT_SESSIONS` | Świadomy fallback; ujednolicić rozwiązywanie katalogu danych |
| [src/constants/index.ts](src/constants/index.ts):18,21,23,25,30 | `.omniagent`, legacy env vars i `omni_sess_` | Zachować jako jednoznaczne stałe kompatybilności |
| `src/constants/index.ts:34,47-55` | Komentarze i 8 nazw `omniagent_*` | Aliasom nadać status deprecated i wskazać zamiennik |
| [src/server.ts](src/server.ts):127-135 | Rejestracja legacy aliasów i komentarze | Zachować kompatybilność; rejestracja przez wspólny katalog narzędzi |
| [src/tools/config.tool.ts](src/tools/config.tool.ts):39 | `handleOmniagentSetDefault` | Deprecated export albo usunięcie po sprawdzeniu odbiorców |
| [src/tools/doctor.tool.ts](src/tools/doctor.tool.ts):38 | `handleOmniagentDoctor` | Jak wyżej |
| [src/tools/issue.tool.ts](src/tools/issue.tool.ts):47 | `handleOmniagentReportBug` | Jak wyżej |
| [src/tools/quota.tool.ts](src/tools/quota.tool.ts):37 | `handleOmniagentQuotaStatus` | Jak wyżej |
| [src/tools/session.tool.ts](src/tools/session.tool.ts):40 | `handleOmniagentCloseSession` | Jak wyżej |
| [test/config.test.js](test/config.test.js):10,14-15 | Prefiks temp i legacy zmienne config/quota | Główne testy na `coagent8_*`; osobne testy zgodności legacy |
| [test/session_and_issue.test.js](test/session_and_issue.test.js):9,11,156,243 | Prefiks temp, legacy env, `omni_sess_expired123`, stara nazwa w kontekście raportu | Zachować fixture legacy sesji; resztę przenieść na Syn |
| [package.json](package.json):10; [package-lock.json](package-lock.json):15 | Bin `omniagent` | Świadomy alias CLI, z określoną polityką wycofania |
| [README.md](README.md):75-82 | 8 legacy nazw narzędzi w tabeli | To poprawna dokumentacja kompatybilności; nie usuwać mechanicznie |
| [docs/PLAN_V1.0.0.md](docs/PLAN_V1.0.0.md) | Stara marka, paczka `omniagent-mcp`, MCP ID, config path, repo i narzędzia | Zaktualizować dokument zgodnie z zestawieniem 4.2 |
| [.agents/rules/author-reviewer.md](.agents/rules/author-reviewer.md):3,13 | OmniAgent i `omniagent_review` jako główna komenda | CoAgent8 i `coagent8_review` |
| [.agents/rules/cross-platform.md](.agents/rules/cross-platform.md):3 | OmniAgent | CoAgent8 |

Nie wykryto dodatkowego starego nazewnictwa w `plugin.json`, `.github/`, `.gitignore`, `index.js`, `LICENSE` ani tekstowym SVG. Binarny PNG nie był analizowany pod kątem metadanych osadzonych w obrazie. `AGENTS.md` i nazwa umiejętności projektu są już CoAgent8.

### 4.2. Pozostałości w roadmap

W `docs/PLAN_V1.0.0.md` stare nazewnictwo występuje w 44 liniach:

- **Marka/paczka/MCP:** 1,6,25,50,139,146,155,184.
- **Konfiguracja:** 24,32,36,54,234.
- **Uchwyty i narzędzia:** 53,116-117,125,140,211-213,216-220,230-237.
- **Nieaktualne repo i zgłoszenia:** 132,137,147 - odwołania do `nyupyu/omniagent`.
- **Opis migracji:** 291,293,296-301 - te wzmianki mogą zostać jako historia migracji, po uaktualnieniu statusu.

Już poprawnie zmieniono generowanie nowych uchwytów na `syn_sess_*`; pruning akceptuje obydwa prefiksy. Nowe główne ścieżki config/session również używają `.coagent8`. To częściowa migracja, a nie potrzeba wykonania globalnej zamiany każdego wystąpienia `omni`.

**Kryterium zakończenia rebrandingu:** stare nazwy pozostają wyłącznie na jawnej liście kompatybilności, w dedykowanych fixtures i historii migracji. Nowe logi, błędy, konfiguracje i przykłady używają CoAgent8. Odbudować `dist/` z aktualnych źródeł, bez ręcznego edytowania bundla.

## 5. Adaptery i procesy CLI

### 5.1. Codex: niezgodna ścieżka native review - F03

`handleReview()` tworzy `cliModelArgs` z `-m`, a następnie przekazuje je do `executeCodexReview()`. Ten uruchamia **`codex review`**, którego lokalne CLI 0.160.0 nie oferuje flagi `-m`. Błąd występuje dla `codex_review_code` z domyślnym scope `uncommitted` albo SHA, bez instrukcji i session handle. Narzędzie `coagent8_review` wymusza ścieżkę `exec`, więc ma inny profil awarii.

Bezpieczna reprodukcja, kończąca się na parsowaniu argv:

~~~text
codex review --config sandbox_mode="read-only" -m gpt-6.1-sol -c model_reasoning_effort=high --uncommitted
error: unexpected argument '-m' found
exitCode = 2
~~~

**Naprawa:** dla `review` przekazywać model przez obsługiwane `--config model=...` z poprawnym kodowaniem wartości TOML, albo ujednolicić wszystkie review na `exec` z przygotowanym scope. Builder argv musi rozróżniać kontrakty `exec`, `exec resume` i `review`. Dodać test rzeczywistego parsowania argv i kontrakty fixture dla wspieranych wersji CLI.

Obecna kolejność `exec --sandbox read-only resume ...` jest rozsądna: sandbox należy do rodzica `exec`. Próba z `--help` potwierdziła parsowanie tej konstrukcji w 0.160.0. Nie ma podstaw, aby zgłaszać ją jako obecny błąd resume.

### 5.2. Rozwiązywanie binarek na Windows - F02

`spawn(..., { shell: false })` jest właściwym domyślnym wyborem, ale nie uruchamia shimów `.cmd` jak terminal PowerShell. `resolveCodexCommand()` zwraca tylko `CODEX_PATH` albo `codex`; Gemini i Claude również przekazują nazwy bez wspólnego resolvera. Zastana zmiana w Codex usunęła poprzedni fallback do pliku JS globalnej instalacji npm.

Próba `runCommand()` z izolowanym, poprawnym plikiem `.cmd` zwróciła **`spawn EINVAL`**. Na tej maszynie Codex działa przy probe dzięki natywnemu `.exe` wcześniej w PATH; wynik nie dowodzi działania instalacji tylko przez npm. Zachowanie `.cmd` opisuje [dokumentacja Node](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).

**Docelowy resolver wspólny dla wszystkich providerów:**

1. Honorować jawny `CODEX_PATH` / `GEMINI_PATH` / `CLAUDE_PATH`; walidować typ pliku i prawo uruchomienia, nie mylić pliku JS z natywną binarką.
2. Rozwiązać PATH/PATHEXT, rozpoznając `.exe`, `.cmd`, `.bat`, `.js` i wariant POSIX. Nie opierać decyzji na `Get-Command` PowerShell - subprocess Node ma własną semantykę.
3. Natywne `.exe` uruchamiać bez shella. Dla znanego shima npm odnaleźć rzeczywisty entrypoint przez `package.json.bin` i uruchomić `process.execPath` z `argsPrefix: [entrypoint]`.
4. Nie hardkodować `%APPDATA%/npm` ani starego `bin/gemini.js`. Metadata odczytanej paczki Gemini 0.62.0 wskazuje `bundle/gemini.js`; instalacje mogą mieć własny prefix.
5. Jeśli wspierany ma być arbitralny `.cmd`, dodać osobny launcher `cmd.exe` z testami quoting i ścisłą walidacją argv. Prompt pozostaje na stdin. Nie wprowadzać ogólnego `shell: true` dla danych użytkownika.
6. Probe, wykonanie i doctor muszą używać tej samej rozstrzygniętej struktury `{ command, argsPrefix, kind, source }`.

Konfigurację komendy należy rozwiązywać w kontrolowanym miejscu, zamiast utrwalać `CODEX_CMD` / `GEMINI_EXE` przy importowaniu modułu. To ułatwia testy, zmianę konfiguracji i poprawne raportowanie rzeczywistej ścieżki.

### 5.3. Pre-abort, deadline i teardown - F05/F06

W `runCommand()` i Claude warunek `abortSignal.aborted` następuje **po `spawn()`**, ale przed założeniem listenera `child.on('error')`. Dla brakującej komendy obietnica zwraca `Operation aborted`, a chwilę później subprocess emituje nieobsłużone ENOENT. Reprodukcja z dodatkowym listenerem audytowym `uncaughtException` potwierdziła obydwa zdarzenia; zwykły serwer może w takiej sytuacji się zakończyć.

`executeCodex()`, `executeCodexReview()` i `executeClaude()` nie mają timeoutu wykonania. Heartbeat co 3 s nie jest deadlinem. W Codex i Claude listenery `abort` nie są zdejmowane po zakończeniu; po kontrolowanym sukcesie Codex liczba listenerów na sygnale wynosiła nadal 1.

Elementy istniejące są wartościowe: stdin/stdout/stderr są pipe, `windowsHide: true`, POSIX używa `detached: true` i sygnału do grupy `-pid`; Windows korzysta z `taskkill /T /F`. Problemy pozostałe:

- POSIX wysyła tylko SIGTERM: proces ignorujący sygnał pozostaje żywy. Brakuje ograniczonego czasu oczekiwania i eskalacji SIGKILL.
- Windows kończy teardown wcześniej, gdy root ma `exitCode !== null` albo `proc.killed`. To nie dowodzi, że jego potomkowie zakończyli pracę. Wynik `taskkill` nie jest oceniany, tylko jego błąd uruchomienia.
- Niszczenie streamów nie jest równoważne zakończeniu procesów. Zbiór `activeProcesses` może być wyczyszczony przed potwierdzonym zakończeniem.
- Globalne listenery SIGINT/SIGTERM instalowane przy imporcie modułu mają skutki uboczne również w testach i ewentualnych konsumentach biblioteki.
- Bootstrap nie ma jawnego shutdown dla aktywnych zadań na EOF stdin. Bezczynny EOF przeszedł próbę; aktywny EOF wymaga testu i kontrolowanego zatrzymania.

**Naprawa:** sprawdzać pre-abort przed spawn; zakładać listenery natychmiast; wspólny idempotentny `settle()` i `cleanup()`; deadline wall-clock oraz ewentualny idle timeout; usuwanie abort listenerów i timerów; await na close i zakończenie drzewa. W POSIX użyć TERM → grace period → KILL. Dla twardej gwarancji drzewa na Windows rozważyć Job Object lub nadzorujący launcher; co najmniej przetestować wariant, w którym root zginął wcześniej od potomka.

### 5.4. Fałszywy sukces i limity danych - F07/F08

Collector wykrywa błędy JSONL, ale `executeCodex()` podejmuje decyzję `isError` wyłącznie na podstawie exit code/signal. W kontrolowanym subprocessie:

~~~json
{"type":"turn.failed","error":{"message":"synthetic protocol failure"}}
~~~

zakończonym kodem 0 uzyskano:

~~~json
{"isError":false,"output":"Task completed cleanly with no textual output."}
~~~

Nie jest to twierdzenie, że każda rzeczywista wersja CLI tak kończy błędy. Jest to potwierdzona luka kontraktu adaptera, która nie wykrywa sprzeczności między protokołem i statusem procesu. Bez terminalnego sukcesu adapter powinien rozróżniać błędy protokołu, brak wyniku i poprawną pustą odpowiedź. Typy `turn.failed`, `turn.completed` i `command_execution` są opisane w [oficjalnej dokumentacji Codex](https://developers.openai.com/codex/noninteractive/).

Pozostałe luki w limitach:

- `fs.readFileSync(tmpFile)` pobiera cały plik `-o` i omija limity collectora. Kontrolowany plik 2 MiB został zwrócony w całości. Przy większym pliku rośnie pamięć procesu i payload MCP.
- `maxLineBuffer` jest sprawdzany tylko wtedy, gdy w buforze **nie ma** newline. Jedna kompletna długa linia z newline albo długi trailing fragment w chunku zawierającym inne linie omija weryfikację.
- Przy `maxTotalMessageBytes: 1` collector zachował 11-bajtowy marker `[truncated]`. Sufiks również musi mieścić się w budżecie; obecne ograniczenia nie są ścisłe.
- Codex ogranicza stderr według `.length`, czyli jednostek UTF-16, i dopisuje cały chunk. Nie są to limity bajtowe.
- `runCommand()` i Claude przy docinaniu `Buffer.subarray()` mogą przeciąć znak UTF-8. Dekodowanie streamów przez `setEncoding('utf8')` chroni granice chunków, ale nie ręczne docinanie.
- Istnieją dwa różne `truncateToByteLength`. W `base.adapter.ts` próba emoji przy limicie 3 B zwróciła `�`; porównanie byteLength nie jest poprawnym testem granicy UTF-8.

**Naprawa:** jeden dekoder i jedna funkcja bezpiecznego docinania; budżety w bajtach dla linii, final output, stderr, błędów i fallbacków; limit pliku przed i podczas odczytu; osobny limit promptu. Po obcięciu nadal drenować stream, ale nie przetwarzać nieskończonych danych bez deadline. Stan `truncated` powinien być częścią wyniku, nie tylko dowolnego tekstu ostrzeżenia.

Plik końcowej odpowiedzi tworzyć w prywatnym katalogu `mkdtemp`, z restrykcyjnymi uprawnieniami i cleanup na każdej ścieżce. Obecna nazwa w globalnym temp oparta o czas i `Math.random()` nie zapewnia prywatnego katalogu roboczego.

## 6. Sesje wieloturowe i retencja

### 6.1. Co działa

Sesje mają niejawne uchwyty, przypisanie do workspace/backend, zapis przez temp + rename, TTL 2 h oraz ochronę aktywnej tury przed TTL. Handlery Codex zapisują `threadId` i zwalniają turę w `finally`. Testy potwierdzają podstawową persystencję, busy w jednym procesie, recovery po martwym PID oraz pruning starszej sesji z prefiksem legacy.

### 6.2. Wyścig podczas reclaim - F09

Reclaim najpierw uznaje lock za stale, a następnie odczytuje token i przenosi plik do `.reap.*`. Nie wykonuje wystarczającej ponownej walidacji właściciela przed przeniesieniem. Co gorsza, `unlinkSync(reapPath)` wykonuje się także wtedy, gdy token przeniesionego locka jest **inny** niż wcześniej odczytany.

Kontrolowana zmiana locka na świeży lock żywego właściciela pomiędzy odczytem i rename zakończyła się:

~~~json
{"injected":true,"ok":true,"freshLockPreserved":false}
~~~

Mutex `.reclaim` serializuje reclaimerów, ale zwykli nabywcy `wx` go nie respektują. Nie stanowi więc pełnego rozwiązania wyścigu. Test nazwany „serializes competing contenders" uruchamia pojedyncze `acquireSessionTurn`, a nie konkurencyjne procesy.

**Naprawa:** jeden sprawdzony protokół blokowania dla normal acquisition i reclaim, z niepowtarzalnym tokenem właściciela, ponowną weryfikacją lease i bez kasowania pliku, którego własności nie potwierdzono. Mutacje sesji i zwalnianie tury powinny sprawdzać token tury, nie tylko PID procesu MCP. Dodać rzeczywiste testy wieloprocesowe oraz deterministyczne testy interleavingów.

### 6.3. Event loop, uszkodzone locki i walidacja - F10/F11

`sleepSync()` używa `Atomics.wait`, z fallbackiem busy-spin. Do 150 prób zatrzymuje obsługę MCP, powiadomień progress, anulowania i timerów. Próba uszkodzonego locka starszego niż 5 s trwała **13 212 ms**, po czym nadal zwróciła błąd locka.

Powód: dla uszkodzonego lub bez-tokenowego locka `isStale` może być prawdziwe, lecz właściwy reclaim wymaga niepustego `staleToken`. Pruning może później usunąć lock po 60 s, ale wywoływany jest leniwie i w batchach; nie naprawia to ścieżki acquire.

Dalsze problemy:

- `getSession()` akceptuje JSON z `lastUsedAt: 'invalid-date'`. `NaN` omija porównanie TTL. Brakuje walidacji backendu, uchwytu, PID, timestampów i native ID.
- `sanitizeHandle()` usuwa niedozwolone znaki. `getSession('../' + poprawnyUchwyt)` odnalazło istniejącą sesję. Nie uzyskano path traversal poza katalog; uzyskano niepożądany alias tokena.
- `updateSession()` zapisuje bez locka i pozwala podmieniać także pola własności; `getSession()` usuwa expired plik bez locka. To otwiera wyścigi ze świeżym acquisition i close.
- `activePid` przechowuje PID serwera MCP, nie subprocessu CLI. Jeżeli serwer żyje, zawieszona tura może pozostać busy bezterminowo; `activeTurnAt` nie ogranicza lease. Ponowne użycie PID po restarcie również nie jest identyfikatorem własności.
- `canonicalPath()` obniża case na Windows tylko w fallbacku, nie w gałęzi `realpath`; trzeba zdefiniować i przetestować jedną strategię tożsamości ścieżki, symlinki i case.
- Pruning wykonuje pełne `readdirSync` mimo batch size 100; pliki `.tmp.*` po awarii nie są objęte jawną polityką cleanup.

**Naprawa:** async backoff, ograniczony czas czekania, restrykcyjny parser uchwytu zgodny z generowanymi i wspieranymi legacy tokenami, schema rekordu, właściciel tury + lease/heartbeat, wszystkie read-modify-write/expiry pod wspólnym lockiem. Nie usuwać aktywnej tury wyłącznie z powodu czasu; odzyskiwanie musi uwzględnić faktyczne zakończenie lub anulowanie procesu.

### 6.4. Unieważnianie i retencja providera - F12

Obecne `closeSession()` usuwa tylko rekord CoAgent8. Nie usuwa natywnej rozmowy Codex ani plików historii providera. Nieistniejący uchwyt powoduje exception przez `acquireSessionTurn`, choć handler obiecuje odpowiedź „not found or already closed". To należy uczynić idempotentnym i jasno opisać.

Po „native session not found", uszkodzeniu rozmowy albo nieodwracalnym błędzie resume nie ma stanu invalidated. Handlery zapisują native ID także z wyników błędnych i wciąż próbują użyć starego uchwytu. Jednocześnie błędy przejściowe, takie jak rate limit, nie powinny automatycznie niszczyć historii.

**Docelowy lifecycle:** `idle → running → idle`, dodatkowo `invalidated` i `closed`; jawny `lastErrorCode`, `nativeSessionId`, wersja CLI i profil bezpieczeństwa. Session handle pozostaje przypisany do providera, niezależnie od późniejszej decyzji `smart_quota`; wznowienie nie może zmieniać providera ani automatycznie otwierać innej rozmowy.

Oddzielić wygaszenie uchwytu CoAgent8 od usunięcia historii providera. Dla Gemini używać pełnego UUID w `--resume`, bez „latest" lub indeksu. Gemini ma również własną retencję; dokumentacja opisuje domyślny `maxAge: 30d` i `minRetention: 1d`, więc 2 h TTL mostu nie oznacza skasowania danych w Gemini. [Zarządzanie sesjami Gemini](https://geminicli.com/docs/cli/session-management/).

Usuwanie natywnych sesji powinno dotyczyć wyłącznie rozmów utworzonych i śledzonych przez CoAgent8, według jawnej konfiguracji retencji. Nie kasować użytkownikowi globalnej historii CLI.

## 7. Proponowana produkcyjna komunikacja z Gemini CLI

To propozycja kompletnego kontraktu i wdrożenia. Obecne repozytorium nie zawiera działającego wykonania Gemini; poniższy projekt wymaga implementacji oraz testów na przypiętych wersjach CLI. Samo zastąpienie atrapy jednym `spawn('gemini', ...)` nie wystarczy.

### 7.1. Najpierw integracja całej ścieżki - F01/F16

Dodać Gemini równocześnie do rejestru adapterów, runtime validation, schema parametrów MCP, konfiguracji allowed/default, doctor, quota i wszystkich uniwersalnych handlerów. Obecne `BackendId` zawiera `gemini`, ale server i narzędzia go odrzucają; `setDefaultBackend('gemini')` przyjmuje wartość, której router nie obsługuje.

`ResolvedBackend.adapter` już istnieje, lecz handlery nie wywołują `backend.adapter.execute()`. Po dodaniu Gemini do routera obecna gałąź „jeżeli Claude, inaczej Codex" nadal uruchamiałaby **Codex z backend.id Gemini**. To potencjalne błędne przesłanie kodu do innego providera i musi być usunięte przed włączeniem Gemini.

Proponowany przepływ:

~~~mermaid
flowchart LR
    A[Parametry MCP] --> B[Walidacja narzędzia]
    B --> C[Rejestr adapterów i routing]
    C --> D[Model i governance]
    D --> E[Sesja i lease tury]
    E --> F[Wspólny runner procesu]
    F --> G[Parser zdarzeń providera]
    G --> H[Wynik i błąd protokołu]
    H --> I[Persystencja sesji i odpowiedź MCP]
~~~

Registry powinien udostępniać rzeczywiste capabilities: `execute`, `resume`, `streaming`, `readOnlyVerified`, `reasoningEffort`. `smart_quota` to strategia, a nie fizyczny backend. Narzędzia `codex_*` pozostają przypięte do Codex; uniwersalne narzędzia korzystają ze wspólnego pipeline.

### 7.2. Wywołanie headless i wybór modelu

Docelowe argv, po zweryfikowaniu profilu ograniczeń:

~~~text
<resolved gemini command> <argsPrefix>
  --output-format stream-json
  --approval-mode default
  --extensions none
  [--model <explicit-model-id>]
  [--resume <native-session-uuid>]
~~~

Prompt przekazywać jako UTF-8 przez stdin, a następnie zamknąć stdin; nie umieszczać kodu repozytorium ani długich promptów w command line. Gemini obsługuje headless dla non-TTY; wariant z krótkim stałym `-p` i stdin można wprowadzić po sprawdzeniu kompozycji promptu dla wybranej wersji. Nie przenosić semantyki Codex `-` do Gemini bez testu. [Tryb headless](https://geminicli.com/docs/cli/headless/).

Model:

- Jeżeli użytkownik poda `model`, przekazać dokładny ID jako osobny argument; bez zmiany na „nowszy" albo na model innego providera.
- Bez override zachować udokumentowaną konfigurację/domysły Gemini; raportować rzeczywiście wybrany model z `init`.
- `availableModels` nie może oznaczać dostępności konta, gdy lista jest tylko hardkodowana. Rozdzielić `knownModels` od potwierdzonego katalogu, dodać źródło i czas odczytu.
- Nie wymuszać `gemini-2.5-flash` / `gemini-2.5-pro` jako jedynych dopuszczalnych ID. Te nazwy w aktualnym probe nie są dynamicznym wykrywaniem.
- Gemini nie powinno automatycznie otrzymać codexowego `model_reasoning_effort` ani claude'owego `MAX_THINKING_TOKENS`. Nieobsługiwany parametr odrzucić z jasnym błędem capability.

### 7.3. Wymuszenie read-only przed spawn

Gemini nie ma równoważnika `--sandbox read-only` z Codex. Nie wolno ogłosić ochrony repozytorium tylko na podstawie promptu „do not edit". Również **`--approval-mode plan` samo w sobie nie daje gwarancji**: dokumentacja headless opisuje możliwość automatycznego wyjścia z planu do YOLO. [Plan mode: non-interactive execution](https://geminicli.com/docs/cli/plan-mode/).

Projekt profilu dla audit/consult/analyze:

1. Utrzymać noninteractive default approval oraz kontrolowaną politykę **deny by default**, z allow tylko dla wymaganych odczytów, np. `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search` - po sprawdzeniu nazw w wybranej wersji.
2. Zakazać zapisu, `replace`, `run_shell_command`, zmiany trybu, zewnętrznych agentów i innych narzędzi spoza allowlisty. Wyłączyć extensions. Ograniczyć lub wyłączyć MCP, hooks i narzędzia sieciowe zgodnie z jawnym profilem, aby nie uruchamiać rozszerzeń użytkownika podczas audytu.
3. Ładować politykę przez wspierany mechanizm konfiguracji dla przypiętej wersji. Dokumentacja opisuje `policyPaths` / `adminPolicyPaths` oraz tiered priorities. Nie wystarczy dopisać workspace policy albo wybrać arbitralnie duże priority - reguły wyższej warstwy mogą ją wyprzedzić.
4. Sprawdzić skuteczny profil przed wykonaniem. Gdy nie można zweryfikować polityki, zakończyć z `SANDBOX_UNAVAILABLE` zamiast użyć mniej restrykcyjnego trybu.
5. Dodać testy odmowy zapisu i uruchomienia shella na natywnym Gemini dla każdego wspieranego OS/CLI. Dla mocniejszej izolacji zastosować read-only mount / sandbox OS, pozostawiając writable tylko kontrolowany storage historii CLI.
6. Zachować auth użytkownika bez kopiowania sekretów do katalogu testowego ani edytowania globalnego `settings.json`. Izolowany profil musi respektować rzeczywistą lokalizację `GEMINI_CLI_HOME` i sposób przechowywania auth.

Przykładowa logika reguł, **nie samowystarczalna gwarancja bezpieczeństwa**:

~~~toml
[[rule]]
toolName = ["read_file", "read_many_files", "list_directory", "glob", "grep_search"]
decision = "allow"
priority = 900

[[rule]]
toolName = "*"
decision = "deny"
priority = 800
~~~

Ostateczną warstwę konfiguracji, nazwy narzędzi i precedencję należy testować z wybraną wersją. Narzędzia MCP mogą mieć odrębne dopasowanie `mcpName`; ich uruchomienie musi być osobno zablokowane. [Policy engine](https://geminicli.com/docs/reference/policy-engine/), [konfiguracja CLI](https://geminicli.com/docs/reference/configuration/).

### 7.4. Collector Gemini: dokładny kontrakt zdarzeń

Oficjalne typy określają m.in. `init.session_id`, `message.role/content/delta`, `error.severity` i `result.status/error/stats`. To jest inny format niż Codex; collectorów nie można współdzielić przez zmianę prefiksu tekstu. [Typy output Gemini](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts).

| Zdarzenie | Działanie adaptera |
| --- | --- |
| `init` | Zweryfikować `session_id` i `model`; zapisać native session ID jako wynik adaptera |
| `message`, role `assistant`, delta true | Dopisywać fragment pod wspólnym budżetem bajtowym |
| `message`, role `assistant`, delta false | Obsłużyć pełną odpowiedź zgodnie z fixture wersji, bez dublowania wcześniejszych delta |
| `message`, role `user` | Nie zwracać odbitego promptu jako odpowiedzi modelu |
| `tool_use` | Emitować krótki, zredagowany progress; nie pokazywać surowych parameters |
| `tool_result` | Aktualizować progress; nie włączać całego output narzędzia do odpowiedzi |
| `error`, warning | Zachować bounded warning; nie mylić automatycznie z fatal error |
| `error`, error | Zachować structured error; nie uznać samego exit 0 za sukces |
| `result` | Terminalny status, błąd i usage; wymagać zgodności z exit/signal |
| Nieznany event | Ograniczony diagnostic/version compatibility; bez crash ani publikowania całego payloadu |

Wymagania parsera: poprawne granice UTF-8 i CRLF, linie JSONL dzielone w dowolnym miejscu, final line bez newline, discard całego oversized record z odzyskaniem następnej granicy, ścisły limit output/stderr, walidacja pól z `unknown`. Malformed stream bez poprawnego terminal result zwraca `PROTOCOL_ERROR`, a nie „clean output".

Warunek sukcesu: brak abort/timeout, exit 0, poprawny terminal `result.status === 'success'` i brak niespójnego fatal statusu. Output może być pusty, ale status nie może wynikać wyłącznie z braku tekstu. Wspierać exit 1, 42 i 53 jako odrębne klasy diagnostyki, zgodnie z headless reference.

### 7.5. Docelowy kontrakt wykonania i szkic integracji

Rozszerzyć `ExecutionOptions` o kontrolowany deadline i limity, `ExecutionResult` o typed error code, signal, truncated, usage i native ID. Jeden typ progress obowiązuje w każdym adapterze.

~~~typescript
type ProviderId = 'codex' | 'gemini' | 'claude';
type ExecutionErrorCode =
  | 'CLI_NOT_FOUND' | 'CLI_UNSUPPORTED' | 'AUTH_REQUIRED'
  | 'MODEL_UNAVAILABLE' | 'RATE_LIMITED' | 'SESSION_INVALID'
  | 'ABORTED' | 'TIMEOUT' | 'SANDBOX_UNAVAILABLE' | 'PROTOCOL_ERROR';

interface ProgressInfo { message: string; completed?: number; total?: number }

interface ProviderCapabilities {
  execute: boolean;
  resume: boolean;
  streaming: boolean;
  readOnlyVerified: boolean;
  reasoningEffort: boolean;
}
~~~

Poniższy szkic pokazuje wyłącznie docelową kompozycję. Helpery `resolveCliLaunch`, `verifyGeminiReadOnlyProfile`, `runCliStream` i collector **nie istnieją obecnie w repozytorium** i należy je wdrożyć z wymaganiami z sekcji 5 oraz 7.3-7.4:

~~~typescript
async function executeGemini(prompt: string, options: ExecutionOptions) {
  validatePromptAndOptions(prompt, options);
  throwIfAborted(options.abortSignal);

  const launch = await resolveCliLaunch('gemini');
  const capabilities = await inspectGeminiCapabilities(launch);
  requireCapabilities(capabilities, { execute: true, resume: !!options.threadId });
  const profile = await verifyGeminiReadOnlyProfile(launch, options.cwd);
  const collector = createGeminiStreamCollector(options.limits);

  const args = [
    ...launch.argsPrefix,
    '--output-format', 'stream-json',
    '--approval-mode', 'default',
    '--extensions', 'none',
  ];
  if (options.model) args.push('--model', options.model);
  if (options.threadId) args.push('--resume', validateNativeSessionId(options.threadId));

  const processResult = await runCliStream({
    command: launch.command, args, cwd: options.cwd,
    env: profile.env, stdin: prompt, signal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    onStdout: chunk => collector.push(chunk),
    onStderr: chunk => collector.addDiagnostic(chunk),
    onProgress: options.onProgress,
  });
  return collector.finish(processResult);
}
~~~

Pipeline poza adapterem nabywa i zwalnia lease sesji w `try/finally`, sprawdza effective model/governance, persystuje potwierdzony native ID i klasyfikuje invalidation. Dzięki temu sam adapter nie powiela logiki session managera.

### 7.6. Błędy, retry i gotowość auth

| Klasa | Zachowanie |
| --- | --- |
| Brak CLI / zły format shima | Fail-fast, konkretna komenda instalacji i rozstrzygnięta ścieżka; brak automatycznego download |
| Unsupported CLI | Podać minimalną wspieraną wersję/capability; nie uruchamiać z nieznanymi flagami |
| Auth required / expired | Podać instrukcję logowania; nie otwierać interaktywnego OAuth w subprocessie MCP |
| Model unavailable | Zwrócić podany ID i błąd; bez automatycznej zmiany providera |
| Rate limit | Zapisać provider-specific cooldown; respektować wiarygodny Retry-After/reset, nie udawać pomiaru quota |
| Native session missing | Unieważnić odpowiedni handle i wyjaśnić, że nowa rozmowa wymaga nowego wywołania |
| Timeout / cancel | Zatrzymać całe drzewo, zwolnić lease po zakończeniu, nie raportować sukcesu |
| Malformed / incomplete stream | `PROTOCOL_ERROR`, bounded sanitized diagnostic, ewentualny partial output jawnie oznaczony |

Retry musi być ograniczony i respektować deadline; ponowienie po częściowo wykonanej turze może dopisać kolejną turę do tej samej sesji. Dla RC bezpiecznym domyślnym zachowaniem jest zwrócenie błędu zamiast transparentnego ponawiania nieidempotentnej rozmowy.

Probe powinien odróżniać `installed`, `executionSupported`, `authEvidence`, `authVerified` i `readOnlyVerified`. Sam katalog `~/.gemini` nie potwierdza działającego logowania. Nie wykonywać generacji jako ukrytego health check.

## 8. Testy i rzeczywiste pokrycie RC 1

### 8.1. Obecny zestaw

| Plik | Liczba testów | Zakres |
| --- | --- | --- |
| `test/config.test.js` | 2 | Persystencja config, walidacja wybranych pól, quota/cooldown/ranking dla dwóch providerów |
| `test/doctor.test.js` | 1 | Ogólny kształt raportu przy rzeczywistym PATH |
| `test/git.test.js` | 4 | Sanity refów oraz typ wyniku staged/uncommitted w aktualnym repo |
| `test/policy.test.js` | 2 | Dokładne aliasy astra/opus i podstawowy workspace check |
| `test/session_and_issue.test.js` | 11 | Sesje, pruning, wybrane błędy/sekrety, sztuczne eventy Codex i budżety |
| **Razem** | **20** | **20/20 PASS**, lecz bez testów wykonania adaptera Gemini i pełnego MCP |

Dodatkowo uruchomiono `node --import tsx --test --experimental-test-coverage`. V8 raportował 80,02% linii dla załadowanych plików łącznie z testami. **Ten agregat nie jest pokryciem całego `src/`**: pomija niezaładowane `server.ts`, `index.ts`, `tools/*` i `base.adapter.ts`, a pomiar TS dotyczy kodu po transformacji. Raport pokazał nawet 100% linii Gemini bez wykonania `execute()`. Nie należy traktować tej wartości jako dowodu kompletnego adaptera.

Nie ma coverage gate, narzędzia obejmującego wszystkie pliki `src/` ani kontroli branch coverage dla krytycznych ścieżek. „100% testów" oznacza pass rate, a nie 100% pokrycia kodu.

### 8.2. Minimalna macierz brakujących testów

| Obszar | Wymagane przypadki przed RC |
| --- | --- |
| Resolver CLI | Windows `.exe` / npm `.cmd` / explicit `.js`; POSIX executable; PATH/PATHEXT; spacje i Unicode; prefix npm poza APPDATA; nieistniejący path; wspólny wynik probe/execute |
| Runner procesu | Success, ENOENT, EINVAL, EACCES; exit nonzero; signal; pre-abort; abort podczas pracy; race abort/error/close; timeout; callback failure; stdin EPIPE; cleanup timer/listener/set |
| Teardown | Potomek ignoruje TERM; leader zakończony przed potomkiem; dziecko trzyma pipe; Windows `taskkill` exit nonzero; brak osieroconych PID po timeout/cancel/shutdown |
| Codex argv | `exec`, `exec resume`, native `review`; sandbox przy każdym wznowieniu; model/effort; stdin `-`; `-o`; rzeczywisty parser wspieranych wersji |
| Codex protokół | Realne `command_execution`, `item.*`, thread ID, turn completed/failed, error + exit 0, stderr + JSON error, final line bez newline, draft → final, empty output, oversized complete record |
| Codex wynik plikowy | Brak pliku, pusty plik, read error, duży plik, cleanup po każdym błędzie, final file zgodny/sprzeczny ze strumieniem |
| Gemini execution | Headless + stdin, model passthrough, nowe session ID, `--resume` pełnego UUID, delta i pełna odpowiedź bez duplikacji, ignorowanie user echo, result status, severity warning/error |
| Gemini błędy | Exit 1/42/53, auth expired, rate limit, unsupported model, malformed JSONL, truncated stream, unknown event, brak terminal result, timeout/cancel |
| Gemini read-only | Faktyczna odmowa `write_file`, `replace`, shell, mode switch, MCP/extension/hook bypass; zgodność polityki na każdej wspieranej wersji i OS |
| Sesje | Dwa rzeczywiste procesy walczące o turę; fresh owner podczas reclaim; corrupt/empty/tokenless lock; stale reclaim mutex; update vs acquire/close/prune; PID reuse; schema/date/native ID; legacy i nowy katalog |
| Routing | Codex-only, Gemini-only, obydwa bez default, explicit provider, wszystkie warianty allowlist, default unavailable, smart quota z 3 kandydatami, resume pinning do providera, brak silent fallback |
| MCP | initialize/list/call; wszystkie 22 nazwy i równoważność aliasów; required/enum/array/unknown fields; typed results; progress token/monotonicity; cancel; EOF podczas pracy; czysty stdout |
| Config/rebranding | Pierwszeństwo SYN nad legacy; migration zachowuje routing; custom data dir; brak przypadkowego odczytu cudzej konfiguracji; kwoty na nowej ścieżce |
| Git scope | Fixture repo: staged, unstaged, untracked content, unborn HEAD, SHA/HEAD~1/branch/range, podkatalog, przekroczony limit, duże/binarne pliki i anulowanie |
| Dystrybucja | Rzeczywisty tarball instalowany w świeżym katalogu; npm bin/shimy; Node minimalny i Node 22; handshake i calls z zainstalowanej paczki; brak dostępu do dev repo/node_modules |

Testy jednostkowe powinny używać kontrolowanych subprocessów i nagranych/syntetycznych eventów zgodnych z rzeczywistym protokołem. Osobne, jawnie uruchamiane smoke tests z autoryzowanym auth potwierdzają rozmowę 2-turową na prawdziwym Codex i Gemini. Wynik testu pominiętego z powodu braku credentials nie jest zaliczonym kryterium release.

### 8.3. Problemy z wiarygodnością i izolacją testów

- `doctor.test.js` zależy od lokalnego PATH; przechodzi także wtedy, gdy wszystkie CLI są nieobecne. Nie dowodzi pracy adapterów.
- `git.test.js` używa aktualnego repozytorium i sprawdza głównie typ tekstu, nie prawidłową treść diff dla poszczególnych scope.
- Testy sesji opisane jako concurrency są przeważnie sekwencyjne. Nie wymuszają konkurencji między procesami.
- Fixtures progress używają `command`, a dokumentacja rzeczywistego Codex wskazuje `command_execution`.
- Testy config/session ustawiają tylko `OMNIAGENT_*`. Jeśli środowisko użytkownika ma `coagent8_CONFIG` lub `coagent8_SESSIONS_DIR`, nowy override ma pierwszeństwo i może kierować testy do prawdziwych danych. Testy muszą ustawiać wszystkie główne ścieżki na własny temp i izolować środowisko przed importem.
- Wyłączenie `test/` z `tsconfig` i szerokie `any` sprawiają, że bramka typów nie wykrywa błędnych argumentów helperów używanych w testach.

**Proponowany gate:** 100% pass rate wymaganych testów, 0 skipped dla release-critical cases, 100% branch coverage decyzji safety/cleanup w wyodrębnionych małych modułach oraz obejmujący całe `src/` raport coverage z sensownym progiem globalnym. Nie narzucać 100% każdego prostego helpera kosztem testów rzeczywistych błędów.

## 9. Architektura, typy, MCP i bezpieczeństwo

### 9.1. Wspólny kontrakt adapterów - F16

Obecny podział plików jest czytelny, lecz kontrakt `CliAdapter` jest głównie deklaracją. Należy wydzielić wspólny executor, provider-specific argv/collector i jeden pipeline narzędzi. Review/consult/analyze duplikują wybór modelu, sesje, finally i formatowanie; każda poprawka wymaga zmian w trzech miejscach.

`ExecutionOptions.onProgress` przyjmuje obiekt, Codex low-level emituje string + liczby, a Claude przekazuje string przez `as any`. Reporter MCP toleruje oba formaty, ale odbiorca zgodny z interfejsem adaptera może dostać zły typ. `userConfirmed` w opcjach adaptera nie jest używane; polityka działa tylko w części handlerów.

Zastąpić `any` dla probe config, parametrów handlerów, wyników i JSON events typami `unknown` + walidacja oraz discriminated unions. `RoutingConfig.allowedBackends` i `SessionRecord.backend` powinny korzystać z `ProviderId`; `BackendId` nie powinno mieszać providerów i strategii.

### 9.2. Schema i walidacja MCP - F15

Niski poziom `Server.setRequestHandler(CallToolRequestSchema, ...)` waliduje envelope i wynik SDK, ale nie wykonuje automatycznie walidacji wszystkich deklarowanych `inputSchema` konkretnych narzędzi. Potwierdzono to również w lokalnej implementacji SDK. Można pozostać przy tym API z centralną walidacją, albo wykorzystać rejestrację z typowaną schema; nie ma potrzeby migracji SDK tylko dla wyglądu architektury.

Konkrety:

- `validateToolArguments()` jest przed `try/catch`. `backend: 'gemini'` w zainstalowanej paczce zwraca JSON-RPC **-32603 InternalError**, a nie błąd narzędzia albo właściwe InvalidParams.
- Server ma jedną listę `auto/codex/claude/smart_quota`, narzędzie set-default własną bez `auto`, a config service dopuszcza również `gemini`.
- Nie są spójnie walidowane `task`, `error_message`, `specification`, `refresh`, elementy `file_paths` / `context_files`, unknown fields i wymagane parametry dla każdego narzędzia.
- Legacy `codex_review_code`, `codex_consult`, `codex_analyze` potrafią w handlerze obsługiwać session handle, ale ich schema nie deklaruje tego pola.
- Katalog jest składany przez `.slice(0,1)` / `.slice(1,2)` / `.slice(2)`. Zmiana kolejności definicji może zmienić listę narzędzi; bez testu katalogu błąd pozostaje niewidoczny.

**Naprawa:** jedna schema/typ na narzędzie, rejestracja nazw z mapy i aliasów, wspólne definicje backendu, walidacja required/enum/minLength/arrays i jawna polityka unknown fields. Dla złych parametrów stosować konsekwentnie `InvalidParams` lub udokumentowany wynik `isError`; nie przypisywać im InternalError. Do narzędzi odczytowych dodać odpowiednie annotations, ale np. set-default i close-session zmieniają lokalny stan.

### 9.3. Redakcja i governance - F13/F14

`generateBugReport()` ma rozbudowane, przydatne maskowanie sekretów i kodu, sprawdzone testami. Jednak server dopisuje **niezredagowane `error.message`** przed zredagowanym raportem. W próbie MCP ze ścieżką zawierającą `token=syntheticAuditSecret` surowy token i home path były widoczne w odpowiedzi. Adaptery zwracają także surowy stderr/error detail; progress może pokazać fragment komendy lub myśli modelu.

**Naprawa:** redakcja w jednym miejscu dla diagnostyki, logów, progress i response errors, przed dodaniem kontekstu lub tworzeniem linku do zgłoszenia. Nie maskować automatycznie całej poprawnej odpowiedzi z wygenerowanym kodem, bo narzędzia mają go dostarczać użytkownikowi. Oddzielić output zadania od telemetry/diagnostic.

W `issue.service.ts:128` nazwy/weryfikowane wersje CLI z doctor są interpolowane bez sanitization; fallback `body: String(errorMessage)` też nie gwarantuje redakcji. Dodać testy na malformed doctor payload, nietypowe wersje i wyjątek redaktora. Ograniczenie wejścia następuje po części obróbki - długi payload już wcześniej jest dzielony na linie; prawdziwe ograniczenie zasobów powinno być wcześniej.

Governance dopasowuje dokładne ID `astra`, `opus`, `claude-3-opus` i jedną wersję Opus. Próba `checkModelGovernance('gpt-6-astra', false)` zwróciła null. Nie twierdzę, że potwierdzono dostępność tego modelu na koncie; potwierdzono brak ochrony ID zawierającego family wskazaną w polityce projektu.

**Naprawa:** rozwiązywać alias do kanonicznego ID, sprawdzać effective model także z konfiguracji i sesji, oraz egzekwować politykę przed każdym spawn. `user_confirmed: true` jest deklaracją caller, nie technicznym dowodem, że wyświetlił modal - dokumentacja powinna opisywać tę granicę zaufania.

Sandbox Codex dotyczy określonego mechanizmu wykonywania komend; profile z zewnętrznymi MCP i hooks wymagają osobnej kontroli. To obszar do testu, nie potwierdzony w tym audycie bypass. Dla Gemini ograniczenie jest warunkiem aktywacji z sekcji 7.3.

### 9.4. Konfiguracja i diagnostyka - F17/F18/F19

Problemy migracji:

- `quota.service.ts` nadal zapisuje w `.omniagent` i nie obsługuje `coagent8_QUOTA_CACHE`.
- Domyślny katalog sessions nie respektuje wspólnego `coagent8_DIR`; nie ma fallback odczytu do dawnego `~/.omniagent/sessions`. Akceptowanie starego prefiksu nie przenosi plików ze starego katalogu.
- `loadConfig()` może sięgnąć do legacy home nawet przy jawnym nowym data dir bez config. `saveConfig()` przy braku nowego pliku zaczyna od defaults, zamiast załadować legacy config, co może utracić ustawienia routingu.
- `routing.strategy` jest walidowane i zapisywane, ale router nie korzysta z niego do decyzji. Np. strategy smart_quota z default codex nadal pozostaje fixed.
- Parser TOML Codex używa regex i nie uwzględnia `CODEX_HOME`, profili, sekcji ani komentarzy. Potrafi odczytać niewłaściwy `model = ...`.

Docelowo: jeden resolver paths z jawną kolejnością primary → legacy i niedestrukcyjną migracją; wspierany schemaVersion, konfiguracja niezależna od czasu importu, zachowanie ustawień oraz kontrolowany atomowy zapis.

Doctor wylicza `default_backend` jako Codex, jeśli jest zainstalowany, niezależnie od zapisanego default/allowlist. Status operational opiera na `--version`. Katalog konfiguracyjny Gemini/Claude jest tylko evidence, a lista modeli jest hardkodowana u wszystkich providerów. Dodać typed `DoctorReport` z `configuredDefault`, `effectiveDefault`, `installed`, `executionSupported`, `authState: unknown/evidence/verified` i profilem read-only.

Quota poprawnie pozostawia `usedPercent/headroomPercent` jako null i `measured: false`. Jednak opis narzędzia obiecuje bieżący headroom 5h, którego nie mierzy. `window: '5h'` jest hardkodowane, cooldown 15 min jest heurystyką. Nie przenosić tej deklaracji na Gemini jako fakt o jego limitach.

Cache jest zapisywany bez atomowego rename i locka. Równoległe procesy mogą nadpisać cooldown lub uszkodzić JSON; odczyt najnowszego cache po probe ogranicza tylko część wyścigów. Ranking sprawdza najwyżej pierwszych dwóch unblocked kandydatów, a router używa stałej kolejności Codex → Claude, zamiast zdefiniowanej preferencji użytkownika.

**Naprawa:** jawne statusy availability/auth/cooldown bez udawanego quota; właściwy ranking wszystkich providerów; atomowy zapis z kontrolą współbieżności; walidacja cache i dat; uwzględnienie provider-specific reset. Zachować brak cichego failover na innego providera.

### 9.5. Progress i zakres review - F20/F21

`formatCodexActivity()` oczekuje `command`, a rzeczywisty przykład CLI używa `command_execution`. Próba takiego eventu zwróciła null. To luka obserwowalności, której obecne fixtures nie ujawniają.

MCP progress rośnie przez zliczanie updates, lecz końcowy status wymusza 100. Po 101 updates uzyskano `[101,100]`, co łamie wymóg wzrostu postępu. Rozdzielić licznik postępu od procentów albo wybrać jedną monotoniczną jednostkę dla całego request. [Specyfikacja MCP progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress).

Git stosuje ważne zabezpieczenia `shell: false`, `--no-ext-diff`, `--no-textconv`, separatory `--` i sanity refów. Natomiast untracked files są tylko listą nazw, nie treścią snapshotu. Model może sam odczytać pliki, ale prompt nie gwarantuje kompletnego review ich zawartości. Przy workspace w podkatalogu tracked diff dotyczy tego katalogu, a untracked list jest pobierana z repo root. Dodatkowo każda część diff ma osobny limit 4 MiB; po ich połączeniu prompt jest większy od pojedynczego limitu.

**Naprawa:** zdefiniować zakres workspace/repo, przygotować bounded snapshot nowych plików lub wymusić sprawdzenie odczytu, oznaczać pliki pominięte i niepełny diff, ograniczyć całkowity prompt. Snapshoty testować na fixture repo, nie na zmiennym working tree projektu.

## 10. Instalacja, manifesty i przygotowanie wydania

### 10.1. Co użytkownik obecnie otrzyma

Lokalny tarball zawiera 42 pliki: bundle + source map, bootstrap, `src/`, obydwa logo, `plugin.json`, README, LICENSE i package.json. npm wygenerował shimy `coagent8`, `coagent8-mcp` i legacy `omniagent`. Konsumencki start MCP przeszedł na Node 20 i 22.

Bundle **nie jest standalone w znaczeniu braku zależności runtime**: ma `require('@modelcontextprotocol/sdk/...')`. SDK jest poprawnie deklarowane w `dependencies`, więc normalna instalacja npm działa. Sam skopiowany `dist/index.cjs` bez zależności nie jest wspieraną paczką standalone; roadmap powinien to opisywać zgodnie ze stanem.

Instalacja CoAgent8 dostarcza most i jego runtime dependencies. **Nie instaluje Codex/Gemini CLI ani nie loguje użytkownika.** To jest zgodne z polityką zero silent downloads. Jeśli celem onboarding jest jeden jawny krok instalujący wszystkie komponenty, można udokumentować komendę npm zawierającą CoAgent8 oraz przypięte, przetestowane pakiety obu CLI, a logowanie opisać osobno. Nie ukrywać takich instalacji w `postinstall`.

`plugin.json` jest manifestem metadanych. Nie ma w repo testu jego zgodności ze schematem konkretnego hosta ani samodzielnego dowodu instalacji w VS Code/Cursor/Antigravity. Handshake stdio jest potwierdzony; zgodność hostowych manifestów i konfiguracji IDE wymaga własnych smoke tests.

### 10.2. Ryzyka release - F04/F22/F23

- package.json, package-lock i `BRAND.SERVER_VERSION` oraz plugin mają `0.9.0-dev`; roadmap jednocześnie zaznacza wykonane tagowanie `v1.0.0-rc.1`. Lokalnie `git tag --list` było puste. Nie weryfikowano tagów zdalnych.
- Publiczny odczyt `coagent8` z registry.npmjs.org zwrócił E404. Zanim README poleci `npm install -g coagent8`, musi istnieć odpowiedni release i dist-tag.
- Brak `prepack`/`prepublishOnly` lub jawnego release job wymuszającego build. `dist/` jest śledzone w Git i może zostać spakowane w wersji niezgodnej ze źródłami.
- `npm pack --dry-run` tylko wyświetla listę; CI nie asertuje obecności wymaganych plików ani nie instaluje tarballa.
- `docs/PLAN_V1.0.0.md` opisuje async backoff, pełne ownership tokens i standalone bundling, podczas gdy kod używa sync wait, PID tury i external SDK. Część checkboxów dotyczy nieistniejących dawnych ścieżek JS/config.
- `tsdown@0.23.0` deklaruje Node `^22.18.0 || ^24.11.0 || >=26.0.0`; `rolldown@1.2.12` wymaga co najmniej Node 20.19 lub odpowiednio nowszego 22. Polyfill umożliwił lokalny build na 20.20.2, lecz nie zmienia zakresu oficjalnego wsparcia bundlera.
- `@types/node@26.6.4` pozwala autorowi odwołać się do API niewystępującego w minimalnym Node 20.0.0. Typy i test runtime minimum powinny odpowiadać deklarowanemu support policy.
- Reguła lokalnego build `<100 ms` jest zależna od maszyny: Node 20 w audycie zbudował poprawnie w 145 ms. Nie jest to błąd funkcjonalny, ale obecny próg nie jest stabilną bramką poprawności.

**Plan dystrybucji:** ujednolicić wersję prerelease i źródło numeru wersji; ustalić wspierane wersje Node/CLI; build i test w CI z lockfile; wygenerować i zainstalować dokładnie ten sam tarball; sprawdzić bin, assety i handshake; wykonać smoke na hostach IDE; dopiero wtedy publikować tag npm i Git z zielonego zatwierdzonego PR. Publikacja nie jest częścią tego audytu.

RC i Beta to nazwy różnych etapów. Dokumentacja wydania powinna wskazać jedno konkretne oznaczenie, np. `1.0.0-beta.1` albo `1.0.0-rc.1`, oraz matching dist-tag. Nie używać jednocześnie „v1.0", „0.9.0-dev" i „RC już wydane" jako opisu tego samego artefaktu.

## 11. Priorytetowy plan refaktoryzacji przed Beta 1

| Kolejność | Priorytet | Zadanie i ustalenia | Mierzalne kryterium zakończenia |
| --- | --- | --- | --- |
| 1 | P0 | Wspólny resolver i runner CLI; F02, F05, F06, F08 | Standardowa instalacja npm i native `.exe` działają; timeout/cancel nie zostawiają potomków; brak uncaught spawn error; wszystkie limity w bajtach |
| 2 | P0 | Poprawić Codex native review i status protokołu; F03, F07 | Poprawne argv dla wspieranych CLI; `turn.failed` nigdy nie jest sukcesem; działający exec oraz resume |
| 3 | P0 | Rejestr adapterów i pełny Gemini pipeline z read-only profile; F01, F16 | Jawne `backend: gemini`, Gemini-only onboarding, review/consult/analyze oraz 2-turn resume na prawdziwym CLI; skuteczna odmowa zapisu |
| 4 | P1 | Naprawić locking, walidację, lease i invalidation sesji; F09-F12 | Testy wieloprocesowe i interleavingów przechodzą; brak utraty fresh locka; event loop nie jest blokowany; invalid handle nie wznawia innej sesji |
| 5 | P1 | Jeden kontrakt schema i typy narzędzi; F15/F16 | Zgodne required/enum/backend w list/call/config; bez `any` na publicznych granicach; aliasy mają identyczne działanie |
| 6 | P1 | Centralna redakcja i effective-model governance; F13/F14 | Syntetyczne sekrety nie wychodzą w diagnostics/progress/errors; aliasy i canonical top-tier IDs są chronione |
| 7 | P1 | Dodać kontrakty adapterów, MCP, bezpieczeństwa i packaging; F24 | Pełna macierz z sekcji 8, wymagane smoke bez skipped, 100% pass, 6/6 CI na wspieranych środowiskach |
| 8 | P2 | Dokończyć migrację config/session/quota i rebranding; F17/F25 | Nowe dane powstają tylko w `.coagent8`; primary env ma pierwszeństwo; migracja zachowuje ustawienia; legacy pozostałości są jawnie oznaczone |
| 9 | P2 | Uczciwy doctor/quota i ranking wszystkich providerów; F18/F19 | Rozdzielona instalacja/auth/capability; brak fałszywych pomiarów; atomowy cache; ranking 3+ kandydatów i stabilne session pinning |
| 10 | P2 | Poprawić progress i snapshot Git; F20/F21 | Postęp monotoniczny, rzeczywiste eventy CLI, wszystkie scope i untracked content mają zweryfikowaną semantykę |
| 11 | P2 → P0 dystrybucji | Uzgodnić toolchain, manifesty, wersję i release artifact; F04/F22/F23 | Consumer install z dokładnego tarballa oraz smoke IDE przechodzą; metadata zgadza się z artefaktem; paczka prerelease jest dostępna pod udokumentowaną komendą |

Zmiany podzielić na małe PR: procesy/resolver → Codex → sesje → registry/schema → Gemini → testy/release metadata. Nie mieszać mechanicznego rename ze zmianą protokołu sesji w jednym dużym diff. Każdy PR ma przejść lokalną 4-etapową bramkę i niezależną kontrolę zgodnie z regułami repozytorium.

## 12. Kryteria dopuszczenia RC 1 / Beta 1

- [ ] Codex i Gemini wykonują review/consult/analyze przez własny CLI, bez błędnego routingu do innego providera.
- [ ] Dwa rzeczywiste obroty rozmowy na obydwu providerach zachowują native session ID, workspace i profil read-only.
- [ ] Brak silent cross-provider fallback; jawnie wybrana strategia `smart_quota` respektuje allowlist i nie zmienia providera istniejącej sesji.
- [ ] Read-only Gemini jest potwierdzone testami skutecznej odmowy narzędzi mutujących, nie tylko flagą plan/default.
- [ ] Naprawione P0/P1/P2 zgodnie z zasadami author-reviewer; brak otwartych findings wymaganych przed merge.
- [ ] 100% wymaganych testów przechodzi, brak skipped krytycznych przypadków, raport coverage obejmuje całe `src/`.
- [ ] Zielone 6/6 CI dla deklarowanego support policy; oddzielny wynik smoke rzeczywistych providerów.
- [ ] Consumer install exact tarball + npm bin + MCP działa na Windows, Ubuntu, macOS i minimalnej deklarowanej wersji Node.
- [ ] Timeout, abort i shutdown kończą procesy oraz zwalniają lease; wszystkie kanały diagnostyki są bounded i zredagowane.
- [ ] Wersja package/lock/plugin/MCP/docs jest jedna; nowa i legacy konfiguracja mają sprawdzoną migrację.
- [ ] Udokumentowana komenda instalacji wskazuje opublikowany prerelease i właściwy dist-tag; wymagania CLI/auth są jawne.

**Decyzja audytora:** obecny working tree przechodzi lokalne kontrole, ale nie spełnia powyższych kryteriów. Nie rekomenduję wydania RC 1/Beta 1 deklarującego produkcyjną komunikację z Gemini do czasu domknięcia wskazanych blokad.
