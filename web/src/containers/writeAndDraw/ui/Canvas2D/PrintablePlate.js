import * as THREE from 'three';
import _ from 'lodash';
import colornames from 'colornames';
// 网格线
import GridLine from './GridLine';
// 坐标轴系
import CoordinateAxes from './CoordinateAxes';
// 文字图形物件
import TextSprite from '../../../../three-extensions/TextSprite';
// 箭头；指定点
import TargetPoint from '../../../../three-extensions/TargetPoint';
import i18next from 'i18next';
import {ARM_BASE_FOOTPRINT, FRONT_END, getLimit} from "../../../../utils/workAreaUtils";
import { getIsAdvance } from '../../../../utils';

const METRIC_GRID_SPACING = 10; // 10 mm
const ARM_BASE_FOOTPRINT_NAME = 'armBaseFootprint';
const ARM_BASE_FOOTPRINT_COLOR = colornames('slategray');

const disposeObject3D = (object) => {
    object.traverse((child) => {
        child.geometry && child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
            if (!material) return;
            material.map && material.map.dispose();
            material.dispose();
        });
    });
};

class PrintablePlate extends THREE.Object3D {
    constructor(size, workHeight, frontEnd, alwaysAddWorkArea) {

        super();
        this.isPrintPlane = true;
        this.type = 'PrintPlane';
        this.targetPoint = null;
        // this.coordinateVisible = true;
        this.coordinateSystem = null;
        this.size = size;
        this.workHeight = workHeight;
        this.frontEnd = frontEnd;
        this.alwaysAddWorkArea = alwaysAddWorkArea || false
        // Rebuild the footprint label when the UI language changes.
        this._onLanguageChanged = () => this.setUpArmBaseFootprint();
        i18next.on('languageChanged', this._onLanguageChanged);
        this._setup();
    }

    dispose() {
        i18next.off('languageChanged', this._onLanguageChanged);
        this.removeArmBaseFootprint();
        const workArea = this.getObjectByName('workArea');
        if (workArea) {
            this.remove(workArea);
            disposeObject3D(workArea);
        }
    }

    updateSize(size) {
        this.size = size;
        this.removeArmBaseFootprint();
        this.remove(...this.children);
        this._setup();
    }

    _setup() {
        console.log('alwaysAddWorkArea = ' + this.alwaysAddWorkArea)

        { // Metric
            const gridSpacing = METRIC_GRID_SPACING;
            const axisXLength = Math.ceil(this.size.x / gridSpacing) * gridSpacing;
            const axisYLength = Math.ceil(this.size.y / gridSpacing) * gridSpacing;

            const group = new THREE.Group();

            { // Coordinate Grid
                const gridLine = new GridLine(
                    axisXLength,
                    gridSpacing,
                    axisYLength,
                    gridSpacing,
                    colornames('blue'), // center line
                    colornames('gray 44') // grid
                );
                _.each(gridLine.children, (o) => {
                    o.material.opacity = 0.15;
                    o.material.transparent = true;
                    o.material.depthWrite = false;
                });
                gridLine.name = 'GridLine';
                group.add(gridLine);
            }


            { // Coordinate Axes
                const coordinateAxes = new CoordinateAxes(axisXLength, axisYLength);
                coordinateAxes.name = 'CoordinateAxes';
                group.add(coordinateAxes);
            }

            { // Axis Labels
                const axisXLabel = new TextSprite({
                    x: axisXLength + 10,
                    y: 0,
                    z: 0,
                    size: 10,
                    text: 'X',
                    color: colornames('red'),
                    checkIsAdvance: true
                });
                const axisYLabel = new TextSprite({
                    x: 0,
                    y: axisYLength + 10,
                    z: 0,
                    size: 10,
                    text: 'Y',
                    color: colornames('green')
                });

                group.add(axisXLabel);
                group.add(axisYLabel);

                const textSize = (10 / 3);
                for (let x = -axisXLength; x <= axisXLength; x += gridSpacing) {
                    if (x !== 0) {
                        const textLabel = new TextSprite({
                            x: x,
                            y: -4,
                            z: 0,
                            size: textSize,
                            text: x,
                            textAlign: 'center',
                            textBaseline: 'bottom',
                            color: colornames('red'),
                            opacity: 0.5
                        });

                        if (getIsAdvance()) {
                            textLabel.translateY(-200)
                        }
                        
                        group.add(textLabel);
                    }
                }
                for (let y = -axisYLength; y <= axisYLength; y += gridSpacing) {
                    if (y !== 0) {
                        const textLabel = new TextSprite({
                            x: -4,
                            y: y,
                            z: 0,
                            size: textSize,
                            text: y + 200,
                            textAlign: 'center',
                            textBaseline: 'bottom',
                            color: colornames('green'),
                            opacity: 0.5
                        });
                        group.add(textLabel);
                    }
                }
            }
            this.coordinateSystem = group;
            group.name = 'MetricCoordinateSystem';
            group.translateY(200);

            this.add(group);
            this.setUpWorkArea(this.workHeight)
        }

        { // Target Point
            this.targetPoint = new TargetPoint({
                color: colornames('indianred'),
                radius: 0.5
            });
            this.targetPoint.name = 'TargetPoint';
            this.targetPoint.visible = true;
            this.add(this.targetPoint);
        }
    }

    changeCoordinateVisibility(value) {
        // this.coordinateVisible = value;
        this.coordinateSystem && (this.coordinateSystem.visible = value);
    }

    setUpWorkArea(workHeight) {
        this.workHeight = workHeight;
        let workArea = this.getObjectByName('workArea')
        if (workArea) {
            this.remove(workArea);
            workArea.geometry.dispose();
            workArea.material.dispose();
        }
        this.setUpArmBaseFootprint();
        const green = colornames('green');
        let limit = getLimit(this.workHeight, this.frontEnd);
        if (!limit) {
            return;
        }

        const path = new THREE.Path();
        path.moveTo(-limit.outerRadius, 0)
            .arc(limit.outerRadius, 0, limit.outerRadius, -Math.PI, 0, true)
            .lineTo(limit.innerRadius, 0)
            .arc(-limit.innerRadius, 0, limit.innerRadius, 0, -Math.PI, false)
            .closePath();
        workArea = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(path.getPoints(100)),
            new THREE.LineBasicMaterial({color: green})
        )
        workArea.name = 'workArea';

        // console.log('高级模式 ' + getIsAdvance())

        // 隐藏弧形区域
        if (!getIsAdvance() || this.alwaysAddWorkArea) {
            // console.log('渲染工作区')
            this.add(workArea);
        } else {
            // console.log('不渲染工作区')
        }
        // this.add(workArea);
    }

    removeArmBaseFootprint() {
        const footprint = this.getObjectByName(ARM_BASE_FOOTPRINT_NAME);
        if (footprint) {
            this.remove(footprint);
            disposeObject3D(footprint);
        }
    }

    // Outline of DexArm's physical base, drawn wherever the work-area outline is
    // shown. Purely visual: it lives outside modelGroup (so it is never picked)
    // and is not part of the out-of-bounds check.
    setUpArmBaseFootprint() {
        this.removeArmBaseFootprint();
        if (getIsAdvance() && !this.alwaysAddWorkArea) {
            return;
        }

        const {minX, maxX, minY, maxY, cornerRadius: r} = ARM_BASE_FOOTPRINT;
        const shape = new THREE.Shape();
        shape.moveTo(minX + r, minY)
            .lineTo(maxX - r, minY)
            .absarc(maxX - r, minY + r, r, -Math.PI / 2, 0, false)
            .lineTo(maxX, maxY - r)
            .absarc(maxX - r, maxY - r, r, 0, Math.PI / 2, false)
            .lineTo(minX + r, maxY)
            .absarc(minX + r, maxY - r, r, Math.PI / 2, Math.PI, false)
            .lineTo(minX, minY + r)
            .absarc(minX + r, minY + r, r, Math.PI, Math.PI * 1.5, false);

        const footprint = new THREE.Group();
        footprint.name = ARM_BASE_FOOTPRINT_NAME;
        // Slightly below the plate so user models always draw on top.
        footprint.position.z = -0.1;

        const fill = new THREE.Mesh(
            new THREE.ShapeBufferGeometry(shape),
            new THREE.MeshBasicMaterial({
                color: ARM_BASE_FOOTPRINT_COLOR,
                transparent: true,
                opacity: 0.12,
                depthWrite: false,
                side: THREE.DoubleSide
            })
        );
        footprint.add(fill);

        const outline = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(shape.getPoints(8)),
            new THREE.LineDashedMaterial({
                color: ARM_BASE_FOOTPRINT_COLOR,
                dashSize: 4,
                gapSize: 2,
                transparent: true,
                opacity: 0.8,
                depthWrite: false
            })
        );
        outline.computeLineDistances();
        footprint.add(outline);

        const label = new TextSprite({
            x: 0,
            y: (minY + maxY) / 2,
            z: 0,
            size: 12,
            text: i18next.t('DexArm Base'),
            color: ARM_BASE_FOOTPRINT_COLOR,
            opacity: 0.9
        });
        footprint.add(label);

        footprint.traverse((child) => {
            child.renderOrder = -1;
            child.raycast = () => {};
        });

        this.add(footprint);
    }
}

export default PrintablePlate;
