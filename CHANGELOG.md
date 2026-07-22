# Changelog

## [0.6.3](https://github.com/teh-hippo/teamdeck/compare/v0.6.2...v0.6.3) (2026-07-22)


### Bug Fixes

* **deps:** update rust crate serde to v1.0.229 ([#67](https://github.com/teh-hippo/teamdeck/issues/67)) ([9fe5670](https://github.com/teh-hippo/teamdeck/commit/9fe5670bca57503698cd9f04cc5e521190cd21a6))

## [0.6.2](https://github.com/teh-hippo/teamdeck/compare/v0.6.1...v0.6.2) (2026-07-08)


### Miscellaneous Chores

* release 0.6.2 ([c65e378](https://github.com/teh-hippo/teamdeck/commit/c65e3786e27d0bd4c6cf556a8b1132652e601290))

## [0.6.1](https://github.com/teh-hippo/teamdeck/compare/v0.6.0...v0.6.1) (2026-07-03)


### Bug Fixes

* isolate the availability opt-in and drop the shared status readout ([dcae3c0](https://github.com/teh-hippo/teamdeck/commit/dcae3c05c742cf972630c3a6d932ae17f05daec1))

## [0.6.0](https://github.com/teh-hippo/teamdeck/compare/v0.5.8...v0.6.0) (2026-07-03)


### Features

* add opt-in Teams availability status tile ([8b4efb7](https://github.com/teh-hippo/teamdeck/commit/8b4efb7ee2cfc87b5abf16649267dfea6a637d70))

## [0.5.8](https://github.com/teh-hippo/teamdeck/compare/v0.5.7...v0.5.8) (2026-07-03)


### Bug Fixes

* **reactions:** show each reaction's own icon on the device ([71f1157](https://github.com/teh-hippo/teamdeck/commit/71f1157c91559316eeb192c501877561400542b5))

## [0.5.7](https://github.com/teh-hippo/teamdeck/compare/v0.5.6...v0.5.7) (2026-07-02)


### Bug Fixes

* actuate and detect raise-hand on the meeting toolbar ([12a2bc0](https://github.com/teh-hippo/teamdeck/commit/12a2bc093fd4453579430fe694db88e6aba58dea))

## [0.5.6](https://github.com/teh-hippo/teamdeck/compare/v0.5.5...v0.5.6) (2026-06-26)


### Performance Improvements

* **helper:** drop the snapshot's redundant second top-level window walk ([fc17def](https://github.com/teh-hippo/teamdeck/commit/fc17def726882e48f52b7b17e3a8f536d0a84cfe))

## [0.5.5](https://github.com/teh-hippo/teamdeck/compare/v0.5.4...v0.5.5) (2026-06-26)


### Performance Improvements

* **helper:** make the serve-loop backstop tick adaptive and stop snapshotting on transient window closes ([eb75682](https://github.com/teh-hippo/teamdeck/commit/eb75682a522833d1f453b633670038fb5bc65d59))

## [0.5.4](https://github.com/teh-hippo/teamdeck/compare/v0.5.3...v0.5.4) (2026-06-25)


### Bug Fixes

* **helper:** respawn immediately when a command hits a broken helper stdin ([6928b27](https://github.com/teh-hippo/teamdeck/commit/6928b2782d9913ffac79baa4cbe82c6d6fbdda2d))

## [0.5.3](https://github.com/teh-hippo/teamdeck/compare/v0.5.2...v0.5.3) (2026-06-25)


### Bug Fixes

* **ui:** escape diagnostic text before rendering it in the property inspector ([0cd80b1](https://github.com/teh-hippo/teamdeck/commit/0cd80b1ae1c522b4b91f2e1a25fc69396256496c))

## [0.5.2](https://github.com/teh-hippo/teamdeck/compare/v0.5.1...v0.5.2) (2026-06-25)


### Bug Fixes

* **helper:** rely solely on the focus-free MSAA path, dropping the Invoke fallback ([a576175](https://github.com/teh-hippo/teamdeck/commit/a576175fecd0f8a364dcd969212118788233d500))

## [0.5.1](https://github.com/teh-hippo/teamdeck/compare/v0.5.0...v0.5.1) (2026-06-25)


### Performance Improvements

* **helper:** cache meeting control elements for fast reads and toggles ([35675ba](https://github.com/teh-hippo/teamdeck/commit/35675ba2e2d83b308d33e95b28217f33595f6487))

## [0.5.0](https://github.com/teh-hippo/teamdeck/compare/v0.4.0...v0.5.0) (2026-06-25)


### Features

* **helper:** drive state reads and the reactions flyout from UIA events ([b1139a9](https://github.com/teh-hippo/teamdeck/commit/b1139a9cad41e42bc2590b6b9872aee3d9418822))

## [0.4.0](https://github.com/teh-hippo/teamdeck/compare/v0.3.0...v0.4.0) (2026-06-25)


### Features

* **helper:** actuate Teams controls via the MSAA default action ([95b1106](https://github.com/teh-hippo/teamdeck/commit/95b110680068f7b491455ab1606299695cf61898))


### Performance Improvements

* **helper:** cache the meeting window and wake the serve loop on commands ([5873e48](https://github.com/teh-hippo/teamdeck/commit/5873e48b968e5b230159628f247f7e757717e801))

## [0.3.0](https://github.com/teh-hippo/teamdeck/compare/v0.2.1...v0.3.0) (2026-06-25)


### Features

* **helper:** read camera state from the OS webcam signal ([7fa1fc2](https://github.com/teh-hippo/teamdeck/commit/7fa1fc2de18f42c0dba1e8429c39d2985c190dfe))
* **plugin:** surface unrecognised control labels as a diagnostic ([67e2309](https://github.com/teh-hippo/teamdeck/commit/67e230962c3fdc26308994da212f07a0cd1e76a1))

## [0.2.1](https://github.com/teh-hippo/teamdeck/compare/v0.2.0...v0.2.1) (2026-06-23)


### Bug Fixes

* **helper:** survive clock and stdin read errors ([f373fb0](https://github.com/teh-hippo/teamdeck/commit/f373fb085d4065d7923fc4137f451181a680edce))
* **teams:** harden the HelperClient state machine ([9448d67](https://github.com/teh-hippo/teamdeck/commit/9448d67e24829ca447ba7a2f48f53d42d0794208))
* **teams:** treat an available-but-null helper signal as unknown ([5957846](https://github.com/teh-hippo/teamdeck/commit/5957846bacc61f15786b7660d29f936610245e47))

## [0.2.0](https://github.com/teh-hippo/teamdeck/compare/v0.1.1...v0.2.0) (2026-06-23)


### Miscellaneous Chores

* release 0.2.0 ([5c24ab3](https://github.com/teh-hippo/teamdeck/commit/5c24ab36613153fc4770e6ba091073e39c94b1d8))
