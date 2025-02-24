/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { basename, dirname, sep } from 'path';
import { Messages, SfError } from '@salesforce/core';
import { ensureString } from '@salesforce/ts-types';
import { MetadataXml, SourceAdapter } from '../types';
import { parseMetadataXml, parseNestedFullName } from '../../utils';
import { ForceIgnore } from '../forceIgnore';
import { NodeFSTreeContainer, TreeContainer } from '../treeContainers';
import { SourceComponent } from '../sourceComponent';
import { SourcePath } from '../../common';
import { MetadataType, RegistryAccess } from '../../registry';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/source-deploy-retrieve', 'sdr');

export abstract class BaseSourceAdapter implements SourceAdapter {
  protected type: MetadataType;
  protected registry: RegistryAccess;
  protected forceIgnore: ForceIgnore;
  protected tree: TreeContainer;

  /**
   * Whether or not an adapter should expect a component to be in its own, self-named
   * folder, including its root metadata xml file.
   */
  protected ownFolder = false;
  protected metadataWithContent = true;

  public constructor(
    type: MetadataType,
    registry = new RegistryAccess(),
    forceIgnore: ForceIgnore = new ForceIgnore(),
    tree: TreeContainer = new NodeFSTreeContainer()
  ) {
    this.type = type;
    this.registry = registry;
    this.forceIgnore = forceIgnore;
    this.tree = tree;
  }

  public getComponent(path: SourcePath, isResolvingSource = true): SourceComponent | undefined {
    let rootMetadata = this.parseAsRootMetadataXml(path);
    if (!rootMetadata) {
      const rootMetadataPath = this.getRootMetadataXmlPath(path);
      if (rootMetadataPath) {
        rootMetadata = this.parseMetadataXml(rootMetadataPath);
      }
    }
    if (rootMetadata && this.forceIgnore.denies(rootMetadata.path)) {
      throw new SfError(
        messages.getMessage('error_no_metadata_xml_ignore', [rootMetadata.path, path]),
        'UnexpectedForceIgnore'
      );
    }

    let component: SourceComponent | undefined;
    if (rootMetadata) {
      const name = this.calculateName(rootMetadata);
      component = new SourceComponent(
        {
          name,
          type: this.type,
          xml: rootMetadata.path,
          parentType: this.type.folderType ? this.registry.getTypeByName(this.type.folderType) : undefined,
        },
        this.tree,
        this.forceIgnore
      );
    }

    return this.populate(path, component, isResolvingSource);
  }

  /**
   * Control whether metadata and content metadata files are allowed for an adapter.
   */
  public allowMetadataWithContent(): boolean {
    return this.metadataWithContent;
  }

  /**
   * If the path given to `getComponent` is the root metadata xml file for a component,
   * parse the name and return it. This is an optimization to not make a child adapter do
   * anymore work to find it.
   *
   * @param path File path of a metadata component
   */
  protected parseAsRootMetadataXml(path: SourcePath): MetadataXml | undefined {
    const metaXml = this.parseMetadataXml(path);
    if (metaXml) {
      let isRootMetadataXml = false;
      if (this.type.strictDirectoryName) {
        const parentPath = dirname(path);
        const typeDirName = basename(this.type.inFolder ? dirname(parentPath) : parentPath);
        const nameMatchesParent = basename(parentPath) === metaXml.fullName;
        const inTypeDir = typeDirName === this.type.directoryName;
        // if the parent folder name matches the fullName OR parent folder name is
        // metadata type's directory name, it's a root metadata xml.
        isRootMetadataXml = nameMatchesParent || inTypeDir;
      } else {
        isRootMetadataXml = true;
      }
      return isRootMetadataXml ? metaXml : undefined;
    }

    const folderMetadataXml = parseAsFolderMetadataXml(path);
    if (folderMetadataXml) {
      return folderMetadataXml;
    }

    if (!this.allowMetadataWithContent()) {
      return this.parseAsContentMetadataXml(path);
    }
  }

  // allowed to preserve API
  // eslint-disable-next-line class-methods-use-this
  protected parseMetadataXml(path: SourcePath): MetadataXml | undefined {
    return parseMetadataXml(path);
  }

  /**
   * If the path given to `getComponent` serves as the sole definition (metadata and content)
   * for a component, parse the name and return it. This allows matching files in metadata
   * format such as:
   *
   * .../tabs/MyTab.tab
   *
   * @param path File path of a metadata component
   */
  private parseAsContentMetadataXml(path: SourcePath): MetadataXml | undefined {
    // InFolder metadata can be nested more than 1 level beneath its
    // associated directoryName.
    if (this.type.inFolder) {
      const fullName = parseNestedFullName(path, this.type.directoryName);
      if (fullName && this.type.suffix) {
        return { fullName, suffix: this.type.suffix, path };
      }
    }

    const parentPath = dirname(path);
    const parts = parentPath.split(sep);
    const typeFolderIndex = parts.lastIndexOf(this.type.directoryName);
    // nestedTypes (ex: territory2) have a folderType equal to their type but are themselves
    // in a folder per metadata item, with child folders for rules/territories
    const allowedIndex = this.type.folderType === this.type.id ? parts.length - 2 : parts.length - 1;

    if (typeFolderIndex !== allowedIndex) {
      return undefined;
    }

    const match = new RegExp(/(.+)\.(.+)/).exec(basename(path));
    if (match && this.type.suffix === match[2]) {
      return { fullName: match[1], suffix: match[2], path };
    }
  }

  // Given a MetadataXml, build a fullName from the path and type.
  private calculateName(rootMetadata: MetadataXml): string {
    const { directoryName, inFolder, folderType, folderContentType } = this.type;

    // inFolder types (report, dashboard, emailTemplate, document) and their folder
    // container types (reportFolder, dashboardFolder, emailFolder, documentFolder)
    if (inFolder || folderContentType) {
      return ensureString(
        parseNestedFullName(rootMetadata.path, directoryName),
        `Unable to calculate fullName from component at path: ${rootMetadata.path} (${this.type.name})`
      );
    }

    // not using folders?  then name is fullname
    if (!folderType) {
      return rootMetadata.fullName;
    }
    const grandparentType = this.registry.getTypeByName(folderType);

    // type is nested inside another type (ex: Territory2Model).  So the names are modelName.ruleName or modelName.territoryName
    if (grandparentType.folderType && grandparentType.folderType !== this.type.id) {
      const splits = rootMetadata.path.split(sep);
      return `${splits[splits.indexOf(grandparentType.directoryName) + 1]}.${rootMetadata.fullName}`;
    }
    // this is the top level of nested types (ex: in a Territory2Model, the Territory2Model)
    if (grandparentType.folderType === this.type.id) {
      return rootMetadata.fullName;
    }
    throw messages.createError('cantGetName', [rootMetadata.path, this.type.name]);
  }

  /**
   * Determine the related root metadata xml when the path given to `getComponent` isn't one.
   *
   * @param trigger Path that `getComponent` was called with
   */
  protected abstract getRootMetadataXmlPath(trigger: SourcePath): SourcePath | undefined;

  /**
   * Populate additional properties on a SourceComponent, such as source files and child components.
   * The component passed to `populate` has its fullName, xml, and type properties already set.
   *
   * @param component Component to populate properties on
   * @param trigger Path that `getComponent` was called with
   */
  protected abstract populate(
    trigger: SourcePath,
    component?: SourceComponent,
    isResolvingSource?: boolean
  ): SourceComponent | undefined;
}

const parseAsFolderMetadataXml = (fsPath: SourcePath): MetadataXml | undefined => {
  const match = new RegExp(/(.+)-meta\.xml$/).exec(basename(fsPath));
  const parts = fsPath.split(sep);
  if (match && !match[1].includes('.') && parts.length > 1) {
    return { fullName: match[1], suffix: undefined, path: fsPath };
  }
};
