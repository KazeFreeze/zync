# Changelog

## [0.11.0](https://github.com/KazeFreeze/zync/compare/zync-v0.10.0...zync-v0.11.0) (2026-08-05)


### Features

* **server:** log disconnects and expose live connections + reconnect storms ([a0bbe98](https://github.com/KazeFreeze/zync/commit/a0bbe98e49044c5c4e40a35295c514d55213bf33))

## [0.10.0](https://github.com/KazeFreeze/zync/compare/zync-v0.9.6...zync-v0.10.0) (2026-08-05)


### Features

* **conflicts:** record and show where each conflict actually came from ([458e5e3](https://github.com/KazeFreeze/zync/commit/458e5e31f89a2c0af6762ead3da28705ca086fa8))

## [0.9.6](https://github.com/KazeFreeze/zync/compare/zync-v0.9.5...zync-v0.9.6) (2026-08-05)


### Bug Fixes

* **plugin:** stop a microtask loop that froze Obsidian on opening settings ([cf43486](https://github.com/KazeFreeze/zync/commit/cf434861ff393260cdb1eef3390ab53eec11db00))

## [0.9.5](https://github.com/KazeFreeze/zync/compare/zync-v0.9.4...zync-v0.9.5) (2026-08-05)


### Performance Improvements

* **config:** stop re-reading unchanged config files at startup and every 30s ([5533116](https://github.com/KazeFreeze/zync/commit/5533116bcd59498f2844906e6c873b82ae02f2f5))

## [0.9.4](https://github.com/KazeFreeze/zync/compare/zync-v0.9.3...zync-v0.9.4) (2026-08-05)


### Bug Fixes

* **plugin:** stop the settings tab flickering while the engine starts ([e5ae0b9](https://github.com/KazeFreeze/zync/commit/e5ae0b99f233a9c7c897c637fc312ad37a928724))

## [0.9.3](https://github.com/KazeFreeze/zync/compare/zync-v0.9.2...zync-v0.9.3) (2026-08-04)


### Bug Fixes

* **core:** persist the first index update immediately, closing a crash window ([033ca00](https://github.com/KazeFreeze/zync/commit/033ca000eb916a10546d59ebc79ecad09edc729c))

## [0.9.2](https://github.com/KazeFreeze/zync/compare/zync-v0.9.1...zync-v0.9.2) (2026-08-04)


### Bug Fixes

* **plugin:** show synced plugin settings as soon as the index is readable ([5dc180f](https://github.com/KazeFreeze/zync/commit/5dc180f971ca758478649cec91451933defff142))

## [0.9.1](https://github.com/KazeFreeze/zync/compare/zync-v0.9.0...zync-v0.9.1) (2026-08-04)


### Bug Fixes

* **sync:** stop an unreachable server from wedging startup ([bc6d5fb](https://github.com/KazeFreeze/zync/commit/bc6d5fb6a1ad4c195d628287a73ba3960a1d4889))

## [0.9.0](https://github.com/KazeFreeze/zync/compare/zync-v0.8.0...zync-v0.9.0) (2026-08-03)


### Features

* **sync:** show what is arriving, not just how much is syncing ([96d382d](https://github.com/KazeFreeze/zync/commit/96d382db8af1cdc796d73a939357d2ad6ff36ff2))

## [0.8.0](https://github.com/KazeFreeze/zync/compare/zync-v0.7.0...zync-v0.8.0) (2026-08-03)


### Features

* **plugin:** render synced settings from the local index, not the relay ([20daf1e](https://github.com/KazeFreeze/zync/commit/20daf1e7cad223a1620f3dc2b4a9f657e39f7194))

## [0.7.0](https://github.com/KazeFreeze/zync/compare/zync-v0.6.6...zync-v0.7.0) (2026-08-03)


### Features

* **core:** persist the shared index so a restart is not blind ([ed86bfc](https://github.com/KazeFreeze/zync/commit/ed86bfcc31a7938b31442a2e9a7cd8796055b827))

## [0.6.6](https://github.com/KazeFreeze/zync/compare/zync-v0.6.5...zync-v0.6.6) (2026-08-03)


### Bug Fixes

* **plugin:** stop showing an unloaded index as "nothing is synced" ([c8e7411](https://github.com/KazeFreeze/zync/commit/c8e7411abd4f17c082275dcba1ed9c8579bc1fe3))

## [0.6.5](https://github.com/KazeFreeze/zync/compare/zync-v0.6.4...zync-v0.6.5) (2026-08-03)


### Bug Fixes

* **plugin:** sort the synced-plugins list by display name ([63ba998](https://github.com/KazeFreeze/zync/commit/63ba998614c992e786186f069b396497c6ec10c6))

## [0.6.4](https://github.com/KazeFreeze/zync/compare/zync-v0.6.3...zync-v0.6.4) (2026-08-03)


### Bug Fixes

* **plugin:** stop bulk dismiss freezing obsidian on a large inbox ([37a2242](https://github.com/KazeFreeze/zync/commit/37a2242e13ad5b03d347354eeed8464fec923487))

## [0.6.3](https://github.com/KazeFreeze/zync/compare/zync-v0.6.2...zync-v0.6.3) (2026-08-03)


### Bug Fixes

* **core:** stop a not-yet-loaded index re-seeding the whole vault ([db85193](https://github.com/KazeFreeze/zync/commit/db851936f0fd31d7f82523ae2167e9b74309fdbd))

## [0.6.2](https://github.com/KazeFreeze/zync/compare/zync-v0.6.1...zync-v0.6.2) (2026-07-29)


### Bug Fixes

* **plugin:** match the status line to the status bar on stuck wording ([235d759](https://github.com/KazeFreeze/zync/commit/235d759832e3af201cb193093e5a9755485d7962))

## [0.6.1](https://github.com/KazeFreeze/zync/compare/zync-v0.6.0...zync-v0.6.1) (2026-07-26)


### Bug Fixes

* **plugin:** stop the stuck row claiming attempts that never happened ([68832c2](https://github.com/KazeFreeze/zync/commit/68832c2aae4673762b002b74308f972efa0e04d9))

## [0.6.0](https://github.com/KazeFreeze/zync/compare/zync-v0.5.2...zync-v0.6.0) (2026-07-26)


### Features

* **plugin:** surface stuck docs as their own state, device-locally ([ebe29bf](https://github.com/KazeFreeze/zync/commit/ebe29bfaaea9bf51faf8d626559f47b98b2b0be8))

## [0.5.2](https://github.com/KazeFreeze/zync/compare/zync-v0.5.1...zync-v0.5.2) (2026-07-26)


### Bug Fixes

* **core:** stop first-seen double-seed minting two docIds per path ([6d7e0de](https://github.com/KazeFreeze/zync/commit/6d7e0de44a60e583e239957766a27e502c89e409))

## [0.5.1](https://github.com/KazeFreeze/zync/compare/zync-v0.5.0...zync-v0.5.1) (2026-07-25)


### Bug Fixes

* **core:** idempotent blob publish to stop bootstrap index churn ([24a97d1](https://github.com/KazeFreeze/zync/commit/24a97d184efafd6328d09e6868ec52237eb2f694))

## [0.5.0](https://github.com/KazeFreeze/zync/compare/zync-v0.4.3...zync-v0.5.0) (2026-07-24)


### Features

* **plugin:** sync-status explainer + full UI design-standard sweep ([b56fcf8](https://github.com/KazeFreeze/zync/commit/b56fcf8de431e8dfb4c437ace2a779226bc9b53b))

## [0.4.3](https://github.com/KazeFreeze/zync/compare/zync-v0.4.2...zync-v0.4.3) (2026-07-24)


### Bug Fixes

* **plugin:** content-based config-sync echo-gate + loop-breaker ([544e137](https://github.com/KazeFreeze/zync/commit/544e137c90fc762eca046bc2b487189122bd0dc7))

## [0.4.2](https://github.com/KazeFreeze/zync/compare/zync-v0.4.1...zync-v0.4.2) (2026-07-23)


### Bug Fixes

* **plugin:** config-sync usability + H1/H2 ([2f7c9a4](https://github.com/KazeFreeze/zync/commit/2f7c9a43c3bef42a758f5f9e73d2293637ccc234))

## [0.4.1](https://github.com/KazeFreeze/zync/compare/zync-v0.4.0...zync-v0.4.1) (2026-07-22)


### Bug Fixes

* **plugin:** mobile connection resilience — bounded index-sync wait + resume reconnect ([26f2f51](https://github.com/KazeFreeze/zync/commit/26f2f514401e7821f7f7403776f6ae20046deb2a))

## [0.4.0](https://github.com/KazeFreeze/zync/compare/zync-v0.3.0...zync-v0.4.0) (2026-07-20)


### Features

* **plugin:** mobile sync-status surface ([d21c737](https://github.com/KazeFreeze/zync/commit/d21c73741edb8d971ce0d6464b9aca0569ccdb52))

## [0.3.0](https://github.com/KazeFreeze/zync/compare/zync-v0.2.0...zync-v0.3.0) (2026-07-18)


### Features

* **plugin:** redesign synced-plugins settings row (single Sync toggle + chevron-expand) ([3bbb3b8](https://github.com/KazeFreeze/zync/commit/3bbb3b8326b745a9edb52d59005484418a46c6f5))

## [0.2.0](https://github.com/KazeFreeze/zync/compare/zync-v0.1.0...zync-v0.2.0) (2026-07-16)


### Features

* admin console HTTP Basic auth (username/password) ([fbe5bb0](https://github.com/KazeFreeze/zync/commit/fbe5bb0da43a97dcf8748d1933cfaacf501e8e51))

## [0.1.0](https://github.com/KazeFreeze/zync/compare/zync-v0.0.1...zync-v0.1.0) (2026-07-15)


### Features

* production server (per-device tokens + admin console) + mid-session pending self-heal ([0733354](https://github.com/KazeFreeze/zync/commit/0733354aedad091b3d878bd1c3d80efd26e6c98e))
