const fs = require('fs');
const path = require('path');
const curl = require('curl');
const {JSDOM} = require('jsdom');
const got = require('got');
const winston = require('winston');

const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(info => {
            return `${info.timestamp} ${info.level}: ${info.message}`;
        })
    ),
    transports: [new winston.transports.Console()]
});


class FactorioWiki {
    _logger;
    _basePath;
    _dataDirectory;
    _imgDataDirectory;
    _items;

    constructor(logger, basePath, dataDirectory) {
        this._basePath = basePath;

        this._dataDirectory = dataDirectory;
        if (!fs.existsSync(this.dataDirectory)) {
            fs.mkdirSync(this.dataDirectory, {recursive: true});
        }

        this._imgDataDirectory = path.resolve(dataDirectory, 'img');
        if (!fs.existsSync(this.imgDataDirectory)) {
            fs.mkdirSync(this.imgDataDirectory, {recursive: true});
        }
        this._logger = logger;
    }

    async init(readonly = true) {
        if (readonly) {
            this.#loadItems();
        } else {

            let changed = false;
            if (await this.readAllItems()) {
                changed = true;
            }
            if (await this.#ensureItemImages()) {
                changed = true;
            }
            if (await this.#ensureRecipes()) {
                changed = true;
            }
            if (!readonly && changed) {
                await this.#saveItems();
            }
        }
    }

    async #readHtmlPage(url) {
        this.logger.debug(`Read html page: '${url}'`);
        return new Promise((resolve, reject) => {
            curl.get(url, null, (err, resp, body) => {
                if (resp.statusCode === 200) {
                    const dom = new JSDOM(body);
                    resolve((require('jquery'))(dom.window));
                } else {
                    reject(err);
                }
            });

        })
    }

    async #downloadFile(url, filePath) {
        this.logger.debug(`Download file '${url}' to '${filePath}'`)
        if (!fs.existsSync(filePath)) {
            got.stream(url).pipe(fs.createWriteStream(filePath));
        }
    }

    #ensureItemImages() {
        let changed = false;
        for (const item of this.items) {
            if (this.#checkAndDownloadItemImage(item)) {
                changed = true;
            }
        }
        return changed;
    }

    async #checkAndDownloadItemImage(item) {
        let changed = false;
        const name = path.basename(item.img.pagePath);
        const filePath = path.resolve(this.imgDataDirectory, name)
        if (!fs.existsSync(filePath)) {
            const url = `${this.basePath}/${item.img.pagePath}`
            await this.#downloadFile(url, filePath);
        }

        if (item.img.localPath !== name) {
            changed = true;
            item.img.localPath = name;
        }
        return changed;
    }

    async readAllItems() {
        if (this.#loadItems()) {
            return;
        }

        this.logger.debug('Load items from Factorio Wiki')
        return this.#readHtmlPage(`${this.basePath}/Items`)
            .then($ => {
                const items = [];
                $('.factorio-icon a').each((i, e) => {
                    const $e = $(e);
                    const item = {
                        name: $e.attr('title'),
                        ref: $e.attr('href'),
                        img: {
                            pagePath: $e.find('img').attr('src')
                        }
                    }
                    this.logger.info(`Add item: '${item.name}'`)
                    items.push(item);
                })

                items.sort((a, b) => a.name < b.name ? -1 : 1);

                this._items = items;
            })
    }

    #saveItems() {
        this.logger.info('Save Items')
        const json = JSON.stringify(this.items, null, 2);
        fs.writeFileSync(this.itemFilePath, json);
    }

    #loadItems() {
        const filePath = this.itemFilePath;
        if (fs.existsSync(filePath)) {
            this.logger.info('Load items from FS')
            this._items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return true;
        }
        return false;
    }

    #findRecipe($, tabbertab) {
        const vrow = $(tabbertab).find('.infobox-vrow-value');
        const parts = $(vrow[0]).find('.factorio-icon');

        const time = $(parts[0]).find('.factorio-icon-text').text();

        const ingredients = [];
        for (let i = 1; i < parts.length - 1; ++i) {
            const count = $(parts[i]).find('.factorio-icon-text').text();
            const title = $(parts[i]).find('a').attr('title');
            ingredients.push({count, title});
        }

        return {time, ingredients};
    }

    async #ensureRecipes() {
        let changed = false;
        for (const item of this.items) {
            if (await this.#ensureRecipe(item)) {
                changed = true;
            }
        }
        return changed;
    }

    async #ensureRecipe(item) {
        if (!item.recipe) {
            return this.#readHtmlPage(`${this.basePath}${item.ref}`)
                .then($ => {
                    const tabbertabs = $.find('.tabbertab');
                    if (tabbertabs.length === 1 || tabbertabs.length === 2) {
                        item.recipe = this.#findRecipe($, tabbertabs[0])
                        this.logger.info(`Add recipe to '${item.name}': '${JSON.stringify(item.recipe)}'`)
                        return true;
                    }
                    return false;
                })
        }
        return false;
    }

    get itemFilePath() {
        return path.resolve(this.dataDirectory, 'items.json');
    }

    get basePath() {
        return this._basePath;
    }

    get dataDirectory() {
        return this._dataDirectory;
    }

    get imgDataDirectory() {
        return this._imgDataDirectory;
    }

    get items() {
        return this._items;
    }

    get logger() {
        return this._logger;
    }
}

class HtmlGenerator {
    _logger;
    _dataDirectory;
    _items;

    constructor(logger, dataDirectory, items) {
        this._logger = logger;
        this._dataDirectory = dataDirectory;
        this._items = items;
    }

    generateItemHtml(item) {
        let result = '';

        result += `<div>${item.recipe.time}</div>`
        for (const i of item.recipe.ingredients) {
            result += `<div>${i.title}(${i.count})</div>`
        }
        return result;
    }

    get items() {
        return this._items;
    }

    get logger() {
        return this._logger;
    }

    get dataDirectory() {
        return this._dataDirectory;
    }
}

(async () => {
    const dataDirectory = './data';
    const basePath = 'https://wiki.factorio.com';

    const factorioWiki = new FactorioWiki(logger, basePath, dataDirectory);
    await factorioWiki.init(true);
    const generator = new HtmlGenerator(logger, dataDirectory, factorioWiki.items);
    console.log(generator.generateItemHtml(factorioWiki.items[0]))
})();

