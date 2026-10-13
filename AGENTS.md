# Repository Guidelines

## Project Structure & Module Organization

This repository is an early scaffold for a rapid development framework based on Taro. The tracked files are `README.md` and `LICENSE`; there is no application source, test suite, or asset directory yet. When adding code, keep related source and tests together or document a new directory layout in `README.md`. Keep generated output and installed dependencies out of version control.

## Build, Test, and Development Commands

There is no package manifest or configured build, test, or development command yet. Do not assume `npm run build` or `npm test` works in this checkout. When introducing tooling, add scripts to the package manifest and document the exact install, local run, build, and test commands in `README.md`. Run those commands before opening a pull request.

## Coding Style & Naming Conventions

No formatter, linter, or indentation policy is configured. Follow the conventions of the files you edit and keep names descriptive and consistent within each module. If you add a formatter or linter, commit its configuration and provide a script contributors can run locally. Use one naming pattern for related files, such as `Component.tsx` for components and `Component.test.tsx` for their tests, if the project adopts TypeScript and React.

## Testing Guidelines

No testing framework or coverage threshold is established. Add tests for behavior introduced or changed by a contribution, and place them near the relevant source or in a clearly named test directory. Include the test command in `README.md` when a test runner is added. For changes that cannot be automated, describe the manual checks in the pull request.

## Commit & Pull Request Guidelines

The Git history contains only `Initial commit`, so it does not establish a commit message convention. Use short, imperative subjects that state the change, such as `Add Taro build configuration`. Keep pull requests focused; explain the purpose, key changes, and verification performed. Link an issue when one exists, and include screenshots for visible UI changes.
