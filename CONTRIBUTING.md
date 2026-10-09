# Contributing

Luoshu Computer contains the MIT local execution client and its protocol and shared utility modules. Core and Console are separate systems.

Use Linux x64, Node.js 22.17.1 and npm. Install Git, tar/gzip, OpenSSL and native build prerequisites (Python 3, make and a C++ compiler).

```sh
npm ci
npm run build
npm run lint
npm test
npm run package
npm run test:package
```

Changes to local authority, file access, process supervision, cancellation and recovery need behavioral regression coverage. Use temporary directories, test keys and deterministic local servers; do not run tests against a real user's device state or paid model account.

Do not use a matching title to infer Task/Run identity or treat a successful Agent run as accepted work. Preserve explicit grants and unknown/recovery states. Changes to wire schemas require coordination with Core; see [compatibility](docs/compatibility.md).

The initial import records its original source commit in `docs/provenance/source-import.json`. Computer's public `main` is the device development branch after this split. The main Luoshu repository retains an explicit compatibility snapshot and its Core integration tests. Synchronize reviewed device/protocol changes through ordinary commits and joint checks, keeping protocol code synchronized deliberately rather than regenerating this repository.

Pull requests should state the resulting behavior, any protocol implications and the checks actually run. Keep private keys, local device identities, API credentials, user state and generated binaries outside Git.
